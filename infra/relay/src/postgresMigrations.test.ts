import * as NodeServices from "@effect/platform-node/NodeServices";
import { PGlite } from "@electric-sql/pglite";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  applyRelayPostgresMigrations,
  PostgresMigrationError,
  readDrizzlePostgresMigrations,
  RELAY_MIGRATIONS_TABLE,
  type PostgresMigrationExecutor,
} from "./postgresMigrations.ts";

const makePgliteExecutor = (db: PGlite): PostgresMigrationExecutor => {
  const query: PostgresMigrationExecutor["query"] = <Row extends Record<string, unknown>>(
    statement: string,
    params?: ReadonlyArray<unknown>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const result = await db.query<Row>(statement, params ? [...params] : undefined);
        return result.rows;
      },
      catch: (cause) =>
        new PostgresMigrationError({
          operation: "query",
          detail: "pglite query failed",
          cause,
        }),
    });

  return {
    query,
    withTransaction: <A, E>(effect: Effect.Effect<A, E>) =>
      query("BEGIN").pipe(
        Effect.andThen(effect),
        Effect.tap(() => query("COMMIT")),
        Effect.onError(() => query("ROLLBACK").pipe(Effect.ignore)),
      ),
  };
};

it.effect(
  "applies migrations/postgres into relay_migrations idempotently and rejects rewritten history",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const migrationsDir = yield* path.fromFileUrl(
        new URL("../migrations/postgres", import.meta.url),
      );
      const records = yield* readDrizzlePostgresMigrations(migrationsDir);
      assert.isTrue(records.length > 0);

      const db = yield* Effect.acquireRelease(
        Effect.promise(() => PGlite.create()),
        (instance) => Effect.promise(() => instance.close()),
      );
      const executor = makePgliteExecutor(db);

      const first = yield* applyRelayPostgresMigrations({ executor, records });
      assert.equal(first.applied.length, records.length);
      assert.equal(first.skipped, 0);

      const recorded = yield* executor.query<{
        readonly id: number;
        readonly hash: string;
        readonly created_at: string | number;
        readonly name: string;
        readonly applied_at: unknown;
      }>(
        `SELECT id, hash, created_at, name, applied_at FROM "${RELAY_MIGRATIONS_TABLE}" ORDER BY id;`,
      );
      assert.equal(recorded.length, records.length);
      for (let index = 0; index < records.length; index += 1) {
        assert.equal(recorded[index]!.name, records[index]!.name);
        assert.equal(recorded[index]!.hash, records[index]!.hash);
        assert.equal(Number(recorded[index]!.created_at), records[index]!.createdAtMillis);
        assert.isDefined(recorded[index]!.applied_at);
      }

      const second = yield* applyRelayPostgresMigrations({ executor, records });
      assert.deepEqual(second, { applied: [], skipped: records.length });

      const rewritten = yield* applyRelayPostgresMigrations({
        executor,
        records: [{ ...records[0]!, hash: "0".repeat(64) }, ...records.slice(1)],
      }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(rewritten));
      if (Result.isFailure(rewritten)) {
        assert.equal(rewritten.failure.operation, "history");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
