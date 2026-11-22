import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Redacted from "effect/Redacted";

import {
  applyRelayPostgresMigrations,
  isPostgresMigrationError,
  PostgresMigrationError,
  readDrizzlePostgresMigrations,
  type PostgresMigrationExecutor,
} from "../src/postgresMigrations.ts";

const optionalTrimmed = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => {
      const trimmed = Option.getOrElse(value, () => "").trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  );

const resolvePgClientConfig = Effect.gen(function* () {
  const explicitUrl = yield* Config.Redacted("RELAY_DATABASE_URL").pipe(
    Config.orElse(() => Config.Redacted("DATABASE_URL")),
    Config.option,
  );
  if (Option.isSome(explicitUrl) && Redacted.value(explicitUrl.value).trim().length > 0) {
    return {
      url: Redacted.make(Redacted.value(explicitUrl.value).trim()),
    } satisfies PgClient.PgClientConfig;
  }

  const host =
    (yield* optionalTrimmed("RELAY_DB_MIGRATION_TARGET_HOST")) ??
    (yield* optionalTrimmed("RELAY_DB_HOST"));
  const rawPort =
    (yield* optionalTrimmed("RELAY_DB_MIGRATION_TARGET_PORT")) ??
    (yield* optionalTrimmed("RELAY_DB_PORT"));
  const database = yield* optionalTrimmed("RELAY_DB_NAME");
  const username = yield* optionalTrimmed("RELAY_DB_USER");
  const password = yield* Config.Redacted("RELAY_DB_PASSWORD").pipe(Config.option);
  const sslMode = (yield* optionalTrimmed("RELAY_DB_MIGRATION_SSLMODE")) ?? "require";

  if (!host || !database || !username || Option.isNone(password)) {
    return yield* new PostgresMigrationError({
      operation: "query",
      detail:
        "Set RELAY_DATABASE_URL (or RELAY_DB_HOST, RELAY_DB_NAME, RELAY_DB_USER, and RELAY_DB_PASSWORD).",
    });
  }
  const port = rawPort ? Number(rawPort) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return yield* new PostgresMigrationError({
      operation: "query",
      detail: "Postgres migration port must be a valid TCP port (1-65535).",
    });
  }
  return {
    host,
    port,
    database,
    username,
    password: Redacted.make(Redacted.value(password.value).trim()),
    ssl: sslMode !== "disable",
  } satisfies PgClient.PgClientConfig;
});

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
  const clientConfig = yield* resolvePgClientConfig;
  const sql = yield* PgClient.make(clientConfig).pipe(
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
