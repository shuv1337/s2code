/**
 * Migrations this fork carries that upstream T3 Code does not.
 *
 * They run on a track of their own, after upstream's, recorded in
 * `FORK_MIGRATIONS_TABLE`. The Effect migrator skips every id at or below the
 * highest one it has recorded, so a fork migration that took one of upstream's
 * ids would make upstream's migration at that id never run. Keeping
 * `Migrations.ts` identical to upstream's lets upstream migrations merge as is.
 *
 * `Migrations.ts` holds only migrations already on upstream's main branch.
 * Add fork-only migrations here, numbered after the last entry, and so are
 * migrations ported from upstream pull requests that upstream has not merged:
 * their ids are not final until it does. When upstream merges one, add a
 * reconcile step that records upstream's id as applied for databases that ran
 * it on this track, then drop it here.
 */

import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/0001_CommandReceiptIdentity.ts";
import ForkMigration0002 from "./ForkMigrations/0002_WatchPairingRequests.ts";
// Upstream peer links (pingdotgg/t3code#16655, #16695), unmerged upstream as 063/064.
import ForkMigration0003 from "./ForkMigrations/0003_PeerLinks.ts";
import ForkMigration0004 from "./ForkMigrations/0004_PeerLinkFence.ts";

export const FORK_MIGRATIONS_TABLE = "shuv_fork_sql_migrations";

export const forkMigrationEntries = [
  [1, "CommandReceiptIdentity", ForkMigration0001],
  [2, "WatchPairingRequests", ForkMigration0002],
  [3, "PeerLinks", ForkMigration0003],
  [4, "PeerLinkFence", ForkMigration0004],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const runForkMigrator = Migrator.make({});

const forkMigrationLoader = Migrator.fromRecord(
  Object.fromEntries(
    forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
  ),
);

/**
 * Run pending fork migrations, after upstream's. They are logged here rather
 * than returned, so `runMigrations` reports upstream's ids alone.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const executed = yield* runForkMigrator({
    loader: forkMigrationLoader,
    table: FORK_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("Fork migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `fork:${id}_${name}`) }),
    );
  }
});

/** Fork ledger rows this build does not know under that id. */
export const divergentForkMigrations = Effect.fn("divergentForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return [];
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  const manifestNames = new Map<number, string>(forkMigrationManifest);
  return recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined)
      return [`fork:${row.migration_id}:${row.name} (unknown to this build)`];
    return expected === row.name
      ? []
      : [`fork:${row.migration_id}:${row.name} (this build: ${expected})`];
  });
});
