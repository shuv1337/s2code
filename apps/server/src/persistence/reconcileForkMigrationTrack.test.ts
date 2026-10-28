import { assert, test } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { forkMigrationManifest } from "./ForkMigrations.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import Identity from "./ForkMigrations/0001_CommandReceiptIdentity.ts";
import Pairing from "./ForkMigrations/0002_WatchPairingRequests.ts";
import PeerLinkPublicKey from "./ForkMigrations/0005_PeerLinkPublicKey.ts";
import UpstreamPeerLinks from "./Migrations/070_PeerLinks.ts";
import UpstreamPeerLinkFence from "./Migrations/071_PeerLinkFence.ts";

const it = makeMethods(test);

const database = NodeSqliteClient.layer({ filename: ":memory:" });

const lastUpstreamId = migrationManifest[migrationManifest.length - 1]![0];

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
      migrationManifest.filter(([id]) => id > 61).map(([id, name]) => [id, name]),
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

    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > 61).map(([id, name]) => [id, name]),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
      migrationManifest.map(([migration_id, name]) => ({ migration_id, name })),
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

// Before upstream shipped peer links as 70 and 71, the fork ran the same schema
// as its own migrations 3 and 4.
it.effect("upgrades a database whose fork track already added peer links", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* Identity;
    yield* Pairing;
    yield* UpstreamPeerLinks;
    yield* UpstreamPeerLinkFence;
    yield* PeerLinkPublicKey;
    yield* sql`CREATE TABLE shuv_fork_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )`;
    for (const [migration_id, name] of forkMigrationManifest) {
      yield* sql`INSERT INTO shuv_fork_sql_migrations (migration_id, name)
        VALUES (${migration_id}, ${name})`;
    }
    yield* sql`INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced)
      VALUES ('env-1', 'secret-1', 'Laptop', '[]', 'full', '2026-10-20', '2026-11-20', 1)`;

    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > 69).map(([id, name]) => [id, name]),
    );
    assert.deepStrictEqual(yield* sql`SELECT environment_id, fenced FROM peer_environment_links`, [
      { environment_id: "env-1", fenced: 1 },
    ]);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);

it.effect("restarts after upstream's own peer link migrations ran", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: lastUpstreamId });
    yield* runMigrations();
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);
