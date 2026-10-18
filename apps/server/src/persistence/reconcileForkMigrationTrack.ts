import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { FORK_MIGRATIONS_TABLE, forkMigrationEntries } from "./ForkMigrations.ts";

// Fork migrations were once recorded in upstream's ledger, at 62 and 63. Move
// them to the fork ledger, keeping when they ran, so upstream's own 62 and 63
// run instead of being skipped. Returns the fork migrations it moved.
export const reconcileForkMigrationTrack = Effect.fn("reconcileForkMigrationTrack")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const forkIds = new Map<string, number>(forkMigrationEntries.map(([id, name]) => [name, id]));
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
        SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id >= 62
      `;
      const moved = history.filter((row) => forkIds.has(row.name));
      if (moved.length === 0) return [];
      if (moved.length !== history.length) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot move fork migrations with upstream migrations recorded after them.",
        });
      }
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
        migration_id integer PRIMARY KEY NOT NULL,
        created_at datetime NOT NULL DEFAULT current_timestamp,
        name VARCHAR(255) NOT NULL
      )`;
      for (const row of moved) {
        yield* sql`
          INSERT INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name, created_at)
          VALUES (${forkIds.get(row.name)!}, ${row.name}, ${row.created_at})
        `;
        yield* sql`
          DELETE FROM effect_sql_migrations
          WHERE migration_id = ${row.migration_id} AND name = ${row.name}
        `;
      }
      return moved.map((row) => [forkIds.get(row.name)!, row.name] as const);
    }),
  );
});
