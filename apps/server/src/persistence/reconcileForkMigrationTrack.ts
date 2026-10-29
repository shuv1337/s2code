import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { FORK_MIGRATIONS_TABLE, forkMigrationEntries } from "./ForkMigrations.ts";

// Fork rows once shared this ledger (receipts and pairing at 62/63, peer links
// at 63/64). Upstream now owns those ids, including its own PeerLinks at 70.
// The migrator will not revisit an id at or below its highest, so after moving
// a fork row, run the upstream migration when a later upstream row is recorded.
export const reconcileForkMigrationTrack = Effect.fn("reconcileForkMigrationTrack")(function* <
  A,
  E,
  R,
>(upstream: ReadonlyArray<readonly [number, string, Effect.Effect<A, E, R>]>) {
  const sql = yield* SqlClient.SqlClient;
  const upstreamById = new Map(upstream.map(([id, name, run]) => [id, { name, run }] as const));
  const forkIdByName = new Map<string, number>(
    forkMigrationEntries.map(([id, name]) => [name, id]),
  );
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return { moved: [], backfilled: [] };
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
        SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id >= 62
      `;
      const misplaced: Array<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
        readonly forkId: number;
      }> = [];
      const unknown: Array<string> = [];
      const seenForkIds = new Set<number>();
      for (const row of history) {
        if (upstreamById.get(row.migration_id)?.name === row.name) continue;
        const forkId = forkIdByName.get(row.name);
        if (forkId === undefined) {
          unknown.push(`${row.migration_id}:${row.name}`);
          continue;
        }
        if (seenForkIds.has(forkId)) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Fork migration ${row.name} is recorded more than once in the upstream ledger.`,
          });
        }
        seenForkIds.add(forkId);
        misplaced.push({ ...row, forkId });
      }
      if (misplaced.length === 0) return { moved: [], backfilled: [] };
      if (unknown.length > 0) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot move fork migrations while the upstream ledger has unrecognized rows: ${unknown.join(", ")}.`,
        });
      }

      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      for (const row of misplaced) {
        const existing = yield* sql<{ readonly name: string }>`
          SELECT name FROM ${sql(FORK_MIGRATIONS_TABLE)} WHERE migration_id = ${row.forkId}
        `;
        const recorded = existing[0];
        if (recorded === undefined) {
          yield* sql`
            INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
            VALUES (${row.forkId}, ${row.name}, ${row.created_at})
          `;
        } else if (recorded.name !== row.name) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Fork ledger id ${row.forkId} is ${recorded.name}, not ${row.name}.`,
          });
        }
        yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id = ${row.migration_id} AND name = ${row.name}
        `;
      }

      // The fork migrator skips every id at or below its highest. Recording a
      // later fork id without the earlier ones would skip those migrations.
      const highestMovedForkId = Math.max(...misplaced.map((row) => row.forkId));
      const forkLedger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM ${sql(FORK_MIGRATIONS_TABLE)}
      `;
      const recordedForkNames = new Map(forkLedger.map((row) => [row.migration_id, row.name]));
      const missingLower = forkMigrationEntries.flatMap(([id, name]) =>
        id < highestMovedForkId && recordedForkNames.get(id) !== name ? [`${id}_${name}`] : [],
      );
      if (missingLower.length > 0) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Cannot move fork migrations while earlier fork migrations are missing from the fork ledger: ${missingLower.join(", ")}.`,
        });
      }

      const [maxRow] = yield* sql<{ readonly id: number | null }>`
        SELECT MAX(migration_id) AS id FROM effect_sql_migrations
      `;
      const maxId = maxRow?.id ?? 0;
      const backfilled: Array<readonly [number, string]> = [];
      for (const row of [...misplaced].sort((a, b) => a.migration_id - b.migration_id)) {
        if (row.migration_id > maxId) continue;
        const migration = upstreamById.get(row.migration_id);
        if (migration === undefined) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot adopt upstream migration ${row.migration_id}; this build has no migration with that id.`,
          });
        }
        yield* migration.run.pipe(
          Effect.mapError(
            (cause) =>
              new Migrator.MigrationError({
                cause,
                kind: "Failed",
                message: `Migration "${row.migration_id}_${migration.name}" failed`,
              }),
          ),
        );
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${row.migration_id}, ${migration.name})
        `;
        backfilled.push([row.migration_id, migration.name]);
      }
      return {
        moved: misplaced.map((row) => [row.forkId, row.name] as const),
        backfilled,
      };
    }),
  );
});
