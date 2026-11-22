// @effect-diagnostics nodeBuiltinImport:off - sha256 hashes migration SQL deterministically to match Alchemy's bookkeeping.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const RELAY_MIGRATIONS_TABLE = "relay_migrations";

const DRIZZLE_DIR_PATTERN = /^\d{14}_.+/u;
const STATEMENT_BREAKPOINT = /\s*-->\s*statement-breakpoint\s*/gu;

export interface PostgresMigrationRecord {
  readonly name: string;
  readonly hash: string;
  readonly createdAtMillis: number | undefined;
  readonly statements: ReadonlyArray<string>;
}

export class PostgresMigrationError extends Schema.TaggedError<PostgresMigrationError>()(
  "PostgresMigrationError",
  {
    operation: Schema.Literals(["read", "query", "apply", "history"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Relay Postgres migration ${this.operation} failed: ${this.detail}`;
  }
}

export const isPostgresMigrationError = Schema.is(PostgresMigrationError);

export interface PostgresMigrationExecutor {
  readonly query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Row>, PostgresMigrationError>;
  readonly withTransaction: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | PostgresMigrationError>;
}

const timestampPrefixMillis = (name: string): number | undefined => {
  const prefix = name.slice(0, 14);
  if (!/^\d{14}$/u.test(prefix)) return undefined;
  const year = Number.parseInt(prefix.slice(0, 4), 10);
  const month = Number.parseInt(prefix.slice(4, 6), 10) - 1;
  const day = Number.parseInt(prefix.slice(6, 8), 10);
  const hour = Number.parseInt(prefix.slice(8, 10), 10);
  const minute = Number.parseInt(prefix.slice(10, 12), 10);
  const second = Number.parseInt(prefix.slice(12, 14), 10);
  return Date.UTC(year, month, day, hour, minute, second);
};

const splitSqlStatements = (sql: string): ReadonlyArray<string> =>
  sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const aliasesOf = (name: string): ReadonlyArray<string> => [
  name,
  `${name}/migration.sql`,
  name.replace(/\/migration\.sql$/u, ""),
];

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** Read Drizzle v1 `{YYYYMMDDHHMMSS}_{name}/migration.sql` entries in Alchemy's exact format. */
export const readDrizzlePostgresMigrations = Effect.fn("RelayMigrations.readDrizzleDir")(function* (
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(dir).pipe(
    Effect.mapError(
      (cause) =>
        new PostgresMigrationError({
          operation: "read",
          detail: `could not list migrations directory ${dir}`,
          cause,
        }),
    ),
  );
  const names: string[] = [];
  for (const entry of entries) {
    if (!DRIZZLE_DIR_PATTERN.test(entry)) continue;
    const sqlPath = path.join(dir, entry, "migration.sql");
    const exists = yield* fs.exists(sqlPath).pipe(
      Effect.mapError(
        (cause) =>
          new PostgresMigrationError({
            operation: "read",
            detail: `could not inspect migration ${entry}`,
            cause,
          }),
      ),
    );
    if (exists) names.push(entry);
  }
  names.sort((a, b) => a.localeCompare(b));

  const records: PostgresMigrationRecord[] = [];
  for (const name of names) {
    const sql = yield* fs.readFileString(path.join(dir, name, "migration.sql")).pipe(
      Effect.mapError(
        (cause) =>
          new PostgresMigrationError({
            operation: "read",
            detail: `could not read migration ${name}`,
            cause,
          }),
      ),
    );
    records.push({
      name,
      hash: NodeCrypto.createHash("sha256").update(sql).digest("hex"),
      createdAtMillis: timestampPrefixMillis(name),
      statements: splitSqlStatements(sql),
    });
  }
  return records;
});

/**
 * Apply pending Drizzle migrations using the same `relay_migrations` schema and
 * SHA-256 bookkeeping as `@alchemy.run/planetscale`, so a database can move
 * cleanly between PlanetScale and self-hosted Postgres.
 */
export const applyRelayPostgresMigrations = Effect.fn("RelayMigrations.apply")(function* (options: {
  readonly executor: PostgresMigrationExecutor;
  readonly records: ReadonlyArray<PostgresMigrationRecord>;
  readonly table?: string;
}) {
  const table = options.table ?? RELAY_MIGRATIONS_TABLE;
  const quoted = quoteIdentifier(table);
  const { executor, records } = options;

  yield* executor.query(`CREATE TABLE IF NOT EXISTS ${quoted} (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint,
  name text,
  applied_at timestamp with time zone DEFAULT now()
);`);

  const rows = yield* executor.query<{ readonly name: unknown; readonly hash: unknown }>(
    `SELECT name, hash FROM ${quoted};`,
  );
  const applied = new Map<string, string | undefined>();
  for (const row of rows) {
    if (row.name === null || row.name === undefined) continue;
    applied.set(
      String(row.name),
      row.hash === null || row.hash === undefined ? undefined : String(row.hash),
    );
  }

  const localNames = new Set(records.flatMap((record) => aliasesOf(record.name)));
  const changed: string[] = [];
  const removed: string[] = [];
  for (const name of applied.keys()) {
    if (!localNames.has(name)) removed.push(name);
  }
  for (const record of records) {
    const existing = aliasesOf(record.name).find((alias) => applied.has(alias));
    if (existing !== undefined) {
      const recordedHash = applied.get(existing);
      if (recordedHash && recordedHash !== record.hash) {
        changed.push(record.name);
      }
    }
  }
  if (changed.length > 0 || removed.length > 0) {
    changed.sort();
    removed.sort();
    const parts = [
      ...(changed.length > 0 ? [`changed: ${changed.join(", ")}`] : []),
      ...(removed.length > 0 ? [`removed: ${removed.join(", ")}`] : []),
    ];
    return yield* new PostgresMigrationError({
      operation: "history",
      detail: `applied migration history in "${table}" does not match local files (${parts.join("; ")})`,
    });
  }

  const newlyApplied: string[] = [];
  for (const record of records) {
    if (aliasesOf(record.name).some((alias) => applied.has(alias))) continue;
    yield* executor.withTransaction(
      Effect.gen(function* () {
        for (const statement of record.statements) {
          yield* executor.query(statement);
        }
        yield* executor.query(
          `INSERT INTO ${quoted} (hash, created_at, name) VALUES ($1, $2, $3);`,
          [record.hash, record.createdAtMillis ?? null, record.name],
        );
      }),
    );
    newlyApplied.push(record.name);
  }

  return {
    applied: newlyApplied,
    skipped: records.length - newlyApplied.length,
  };
});
