import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import PullRequestReviewGuides from "./Migrations/061_PullRequestReviewGuides.ts";

// Watch previews used 61/62 before the installed nightly reserved 61 for review guides.
// Preserve those previews' existing receipt identities and outstanding pairing requests.
// It leaves them at 62/63 in upstream's ledger; reconcileForkMigrationTrack then moves them
// to the fork ledger.
export const reconcileWatchPreviewMigration = Effect.fn("reconcileWatchPreviewMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
        if (tables.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 61
      `;
        if (
          !history.some((row) => row.migration_id === 61 && row.name === "CommandReceiptIdentity")
        )
          return [];
        if (
          !history.every(
            (row) =>
              (row.migration_id === 61 && row.name === "CommandReceiptIdentity") ||
              (row.migration_id === 62 && row.name === "WatchPairingRequests"),
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade Watch preview with unexpected later migrations.",
          });
        }
        yield* PullRequestReviewGuides;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 63 WHERE migration_id = 62 AND name = 'WatchPairingRequests'`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 62 WHERE migration_id = 61 AND name = 'CommandReceiptIdentity'`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'PullRequestReviewGuides')`;
        return [[61, "PullRequestReviewGuides"]] as const;
      }),
    );
  },
);
