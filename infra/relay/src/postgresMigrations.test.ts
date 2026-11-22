import * as NodeServices from "@effect/platform-node/NodeServices";
import { PGlite } from "@electric-sql/pglite";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import {
  applyRelayPostgresMigrations,
  PostgresMigrationError,
  readDrizzlePostgresMigrations,
  RELAY_MIGRATIONS_TABLE,
  resolveMigrationPgClientConfig,
  splitPostgresSqlScript,
  type PostgresMigrationExecutor,
} from "./postgresMigrations.ts";

const makePgliteExecutor = (
  db: PGlite,
  options?: {
    readonly withLock?: PostgresMigrationExecutor["withLock"];
    readonly onQuery?: (statement: string) => Effect.Effect<void>;
  },
): PostgresMigrationExecutor => {
  const query: PostgresMigrationExecutor["query"] = <Row extends Record<string, unknown>>(
    statement: string,
    params?: ReadonlyArray<unknown>,
  ) =>
    (options?.onQuery ? options.onQuery(statement) : Effect.void).pipe(
      Effect.andThen(
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
        }),
      ),
    );

  return {
    query,
    withTransaction: <A, E>(effect: Effect.Effect<A, E>) =>
      query("BEGIN").pipe(
        Effect.andThen(effect),
        Effect.tap(() => query("COMMIT")),
        Effect.onError(() => query("ROLLBACK").pipe(Effect.ignore)),
      ),
    ...(options?.withLock ? { withLock: options.withLock } : {}),
  };
};

it.effect(
  "applies migrations/postgres under pg_advisory_lock idempotently and rejects rewritten history",
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
      const seenSql: string[] = [];
      const executor = makePgliteExecutor(db, {
        onQuery: (statement) =>
          Effect.sync(() => {
            seenSql.push(statement);
          }),
      });

      const first = yield* applyRelayPostgresMigrations({ executor, records });
      assert.equal(first.applied.length, records.length);
      assert.equal(first.skipped, 0);
      assert.include(seenSql[0] ?? "", "pg_advisory_lock");
      assert.include(seenSql[seenSql.length - 1] ?? "", "pg_advisory_unlock");

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

it.effect("splits multi-statement Postgres scripts without breakpoint comments accurately", () =>
  Effect.gen(function* () {
    const sql = `
      -- Leading comment; should not split
      CREATE TABLE items (id integer PRIMARY KEY, label text NOT NULL);
      /* Nested /* block ; comment */ still comment */
      INSERT INTO items (id, label) VALUES (1, 'a;b''c'), (2, E'd\\';e');
      DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;
    `;
    const statements = splitPostgresSqlScript(sql);
    assert.equal(statements.length, 3);

    const db = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (instance) => Effect.promise(() => instance.close()),
    );
    const executor = makePgliteExecutor(db);
    yield* applyRelayPostgresMigrations({
      executor,
      records: [
        {
          name: "20261121000001_no_breakpoints",
          hash: "a".repeat(64),
          createdAtMillis: 1,
          statements,
        },
      ],
    });
    const rows = yield* executor.query<{ readonly id: number; readonly label: string }>(
      "SELECT id, label FROM items ORDER BY id;",
    );
    assert.deepEqual(rows, [
      { id: 1, label: "a;b'c" },
      { id: 2, label: "d';e" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("rolls back a failing migration and records nothing in relay_migrations", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (instance) => Effect.promise(() => instance.close()),
    );
    const executor = makePgliteExecutor(db);
    const failure = yield* applyRelayPostgresMigrations({
      executor,
      records: [
        {
          name: "20261121000002_partial_fail",
          hash: "b".repeat(64),
          createdAtMillis: 2,
          statements: [
            "CREATE TABLE rolled_back_items (id integer PRIMARY KEY)",
            "INSERT INTO nonexistent_table (id) VALUES (1)",
          ],
        },
      ],
    }).pipe(Effect.result);
    assert.isTrue(Result.isFailure(failure));

    const tables = yield* executor.query<{ readonly table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'rolled_back_items';",
    );
    assert.equal(tables.length, 0);

    const recorded = yield* executor.query(`SELECT name FROM "${RELAY_MIGRATIONS_TABLE}";`);
    assert.equal(recorded.length, 0);
  }).pipe(Effect.scoped),
);

it.effect("serializes two concurrent migration runs so each migration is recorded once", () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (instance) => Effect.promise(() => instance.close()),
    );
    const sessionLock = yield* Semaphore.make(1);
    const firstEntered = yield* Deferred.make<void>();
    const allowFirstToFinish = yield* Deferred.make<void>();
    let lockAcquisitions = 0;

    const makeSessionExecutor = () =>
      makePgliteExecutor(db, {
        withLock: (_lockKey, effect) =>
          sessionLock.withPermit(
            Effect.gen(function* () {
              lockAcquisitions += 1;
              if (lockAcquisitions === 1) {
                yield* Deferred.succeed(firstEntered, undefined);
                yield* Deferred.await(allowFirstToFinish);
              }
              return yield* effect;
            }),
          ),
      });

    const records = [
      {
        name: "20261121000003_concurrent_a",
        hash: "c".repeat(64),
        createdAtMillis: 3,
        statements: ["CREATE TABLE IF NOT EXISTS concurrent_a (id integer PRIMARY KEY)"],
      },
    ];

    const firstFiber = yield* Effect.forkChild(
      applyRelayPostgresMigrations({ executor: makeSessionExecutor(), records }),
    );
    yield* Deferred.await(firstEntered);

    const secondFiber = yield* Effect.forkChild(
      applyRelayPostgresMigrations({ executor: makeSessionExecutor(), records }),
    );
    yield* Deferred.succeed(allowFirstToFinish, undefined);

    const [firstResult, secondResult] = yield* Effect.all([
      Fiber.join(firstFiber),
      Fiber.join(secondFiber),
    ]);
    assert.deepEqual(firstResult, { applied: ["20261121000003_concurrent_a"], skipped: 0 });
    assert.deepEqual(secondResult, { applied: [], skipped: 1 });

    const rows = yield* makePgliteExecutor(db).query<{ readonly name: string }>(
      `SELECT name FROM "${RELAY_MIGRATIONS_TABLE}";`,
    );
    assert.deepEqual(rows, [{ name: "20261121000003_concurrent_a" }]);
  }).pipe(Effect.scoped),
);

it.effect(
  "validates migration hosts and maps RELAY_DB_MIGRATION_SSLMODE modes in resolveMigrationPgClientConfig",
  () =>
    Effect.gen(function* () {
      const provideEnv = (env: Readonly<Record<string, string>>) =>
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

      const localUrl = yield* resolveMigrationPgClientConfig().pipe(
        provideEnv({
          RELAY_DATABASE_URL:
            "postgresql://relay:secret@127.0.0.1:5432/s2coderelay?sslmode=disable",
        }),
      );
      assert.equal(
        localUrl.url ? Redacted.value(localUrl.url) : undefined,
        "postgresql://relay:secret@127.0.0.1:5432/s2coderelay?sslmode=disable",
      );

      for (const badEnv of [
        { RELAY_DATABASE_URL: "postgresql://relay:secret@db.t3.codes:5432/s2coderelay" },
        { RELAY_DATABASE_URL: "postgresql://relay:secret@db.example.com:5432/s2coderelay" },
        {
          RELAY_DB_HOST: "db.t3.codes",
          RELAY_DB_NAME: "s2coderelay",
          RELAY_DB_USER: "relay",
          RELAY_DB_PASSWORD: "secret",
        },
        {
          RELAY_DB_HOST: "pg.s2code.dev",
          RELAY_DB_NAME: "s2coderelay",
          RELAY_DB_USER: "relay",
          RELAY_DB_PASSWORD: "secret",
          RELAY_DB_MIGRATION_SSLMODE: "bogus",
        },
      ]) {
        const result = yield* resolveMigrationPgClientConfig().pipe(
          provideEnv(badEnv),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result), JSON.stringify(badEnv));
      }

      const base = {
        RELAY_DB_HOST: "pg.s2code.dev",
        RELAY_DB_NAME: "s2coderelay",
        RELAY_DB_USER: "relay",
        RELAY_DB_PASSWORD: "secret",
      };
      const disabled = yield* resolveMigrationPgClientConfig().pipe(
        provideEnv({
          ...base,
          RELAY_DB_MIGRATION_TARGET_HOST: "127.0.0.1",
          RELAY_DB_MIGRATION_TARGET_PORT: "15432",
          RELAY_DB_MIGRATION_SSLMODE: "disable",
        }),
      );
      assert.equal(disabled.ssl, false);
      assert.equal(disabled.host, "127.0.0.1");
      assert.equal(disabled.port, 15432);

      const required = yield* resolveMigrationPgClientConfig().pipe(
        provideEnv({ ...base, RELAY_DB_MIGRATION_SSLMODE: "require" }),
      );
      assert.deepEqual(required.ssl, { rejectUnauthorized: false });

      const verifyFullTunnel = yield* resolveMigrationPgClientConfig().pipe(
        provideEnv({
          ...base,
          RELAY_DB_MIGRATION_TARGET_HOST: "127.0.0.1",
          RELAY_DB_MIGRATION_TARGET_PORT: "15432",
          RELAY_DB_MIGRATION_SSLMODE: "verify-full",
        }),
      );
      assert.deepEqual(verifyFullTunnel.ssl, {
        rejectUnauthorized: true,
        servername: "pg.s2code.dev",
      });

      const prefer = yield* resolveMigrationPgClientConfig().pipe(
        provideEnv({ ...base, RELAY_DB_MIGRATION_SSLMODE: "prefer" }),
      );
      assert.isDefined(prefer.url);
      assert.include(Redacted.value(prefer.url!), "sslmode=prefer");
    }),
);
