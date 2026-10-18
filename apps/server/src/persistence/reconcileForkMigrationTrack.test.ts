import { assert, test } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { forkMigrationManifest } from "./ForkMigrations.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import Identity from "./ForkMigrations/0001_CommandReceiptIdentity.ts";
import Pairing from "./ForkMigrations/0002_WatchPairingRequests.ts";

const it = makeMethods(test);

const database = NodeSqliteClient.layer({ filename: ":memory:" });

const lastUpstreamId = migrationEntries[migrationEntries.length - 1]![0];

it.effect("runs fork migrations on their own ledger after upstream's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM shuv_fork_sql_migrations ORDER BY migration_id`,
      forkMigrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
    );
    const [upstream] = yield* sql<{ id: number }>`
      SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
    assert.equal(upstream?.id, lastUpstreamId);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);

it.effect("moves fork migrations out of upstream's ledger, keeping when they ran", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* Identity;
    yield* Pairing;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
      (62, 'CommandReceiptIdentity', '2026-10-10 10:00:00'),
      (63, 'WatchPairingRequests', '2026-10-12 12:00:00')`;
    yield* sql`INSERT INTO auth_watch_pairing_requests
      (device_code_hash, user_code, status, created_at, expires_at)
      VALUES ('test-hash', 'ABCDEF', 'pending', '2026-10-12', '2026-10-13')`;

    // Upstream migrations after 61 now run instead of being skipped.
    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationEntries.filter(([id]) => id > 61).map(([id, name]) => [id, name]),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations
        WHERE name IN ('CommandReceiptIdentity', 'WatchPairingRequests')`,
      [],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name, created_at FROM shuv_fork_sql_migrations
        WHERE name IN ('CommandReceiptIdentity', 'WatchPairingRequests') ORDER BY migration_id`,
      [
        { migration_id: 1, name: "CommandReceiptIdentity", created_at: "2026-10-10 10:00:00" },
        { migration_id: 2, name: "WatchPairingRequests", created_at: "2026-10-12 12:00:00" },
      ],
    );
    assert.equal((yield* sql`SELECT * FROM auth_watch_pairing_requests`).length, 1);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);

// Today's live databases: upstream 1..61, then fork rows holding upstream's 62
// and 63. Upstream's V2 check rejects foreign names at V2 ids, so the fork
// track must be reconciled before it runs, or startup fails.
it.effect("boots a database with fork rows at upstream's 62 and 63 under the V2 check", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* Identity;
    yield* Pairing;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
      (62, 'CommandReceiptIdentity'), (63, 'WatchPairingRequests')`;
    yield* sql`INSERT INTO auth_watch_pairing_requests
      (device_code_hash, user_code, status, created_at, expires_at)
      VALUES ('live-hash', 'LIVE01', 'pending', '2026-10-12', '2026-10-13')`;

    assert.deepStrictEqual(yield* runMigrations(), [
      [62, "ThreadFailureLookupIndex"],
      [63, "DropUnusedV1Projections"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
      migrationEntries.map(([migration_id, name]) => ({ migration_id, name })),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM shuv_fork_sql_migrations ORDER BY migration_id`,
      forkMigrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT device_code_hash, user_code FROM auth_watch_pairing_requests`,
      [{ device_code_hash: "live-hash", user_code: "LIVE01" }],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);

it.effect("refuses to move fork migrations with upstream ones recorded after them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* Identity;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
      (62, 'CommandReceiptIdentity'), (63, 'Unexpected')`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations`;
    const result = yield* runMigrations().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM effect_sql_migrations`, before);
  }).pipe(Effect.provide(database)),
);
