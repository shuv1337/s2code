import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Reactivity from "effect/reactivity/Reactivity";

import {
  applyRelayPostgresMigrations,
  isPostgresMigrationError,
  PostgresMigrationError,
  readDrizzlePostgresMigrations,
  resolveMigrationPgClientConfig,
  type PostgresMigrationExecutor,
} from "../src/postgresMigrations.ts";

const makePgExecutor = (sql: PgClient.PgClient): PostgresMigrationExecutor => ({
  query: <Row extends Record<string, unknown>>(
    statement: string,
    params?: ReadonlyArray<unknown>,
  ) =>
    sql.unsafe<Row>(statement, params).pipe(
      Effect.mapError(
        (cause) =>
          new PostgresMigrationError({
            operation: "query",
            detail: "database statement failed",
            cause,
          }),
      ),
    ),
  withTransaction: <A, E>(effect: Effect.Effect<A, E>) =>
    sql.withTransaction(effect).pipe(
      Effect.mapError((error) =>
        isPostgresMigrationError(error)
          ? error
          : new PostgresMigrationError({
              operation: "apply",
              detail: "database transaction failed",
              cause: error,
            }),
      ),
    ) as Effect.Effect<A, E | PostgresMigrationError>,
});

const main = Effect.gen(function* () {
  const path = yield* Path.Path;
  const migrationsDir = yield* path.fromFileUrl(new URL("../migrations/postgres", import.meta.url));
  const records = yield* readDrizzlePostgresMigrations(migrationsDir);
  const clientConfig = yield* resolveMigrationPgClientConfig();
  // Single dedicated session so session-level pg_advisory_lock and transactions share one connection.
  const sql = yield* PgClient.makeClient(clientConfig).pipe(
    Effect.mapError(
      (cause) =>
        new PostgresMigrationError({
          operation: "query",
          detail: "could not connect to Postgres",
          cause,
        }),
    ),
  );
  const result = yield* applyRelayPostgresMigrations({
    executor: makePgExecutor(sql),
    records,
  });
  yield* Console.log(
    `Relay Postgres migrations complete: ${result.applied.length} applied, ${result.skipped} already applied.`,
  );
}).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, Reactivity.layer)));

NodeRuntime.runMain(main);
