import { assert, test } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import Identity from "./Migrations/062_CommandReceiptIdentity.ts";
import Pairing from "./Migrations/063_WatchPairingRequests.ts";

const it = makeMethods(test);

const database = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("upgrades the installed nightly with review guides at 61", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* sql`INSERT INTO pull_request_review_guides VALUES ('github', 'owner/repo', 1, '{}')`;
    assert.deepStrictEqual(yield* runMigrations(), [
      [62, "CommandReceiptIdentity"],
      [63, "WatchPairingRequests"],
    ]);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(orchestration_command_receipts)`;
    assert.ok(columns.some((column) => column.name === "payload_fingerprint"));
    assert.equal((yield* sql`SELECT * FROM pull_request_review_guides`).length, 1);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(database)),
);

it.effect.each([false, true])(
  "upgrades Watch preview without losing data (pairing schema: %s)",
  (paired) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* Identity;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'CommandReceiptIdentity')`;
      if (paired) {
        yield* Pairing;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (62, 'WatchPairingRequests')`;
        yield* sql`INSERT INTO auth_watch_pairing_requests
          (device_code_hash, user_code, status, created_at, expires_at)
          VALUES ('test-hash', 'ABCDEF', 'pending', '2026-10-12', '2026-10-13')`;
      }
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 61 ORDER BY migration_id`,
        [
          { migration_id: 61, name: "PullRequestReviewGuides" },
          { migration_id: 62, name: "CommandReceiptIdentity" },
          { migration_id: 63, name: "WatchPairingRequests" },
        ],
      );
      assert.equal((yield* sql`SELECT * FROM auth_watch_pairing_requests`).length, paired ? 1 : 0);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(database)),
);

it.effect("rejects unexpected preview history before changing the ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 60 });
    yield* Identity;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'CommandReceiptIdentity'), (62, 'Unexpected')`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations`;
    const result = yield* runMigrations().pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(yield* sql`SELECT * FROM effect_sql_migrations`, before);
  }).pipe(Effect.provide(database)),
);
