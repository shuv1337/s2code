// @effect-diagnostics nodeBuiltinImport:off - crypto hashes migration SQL deterministically; net/tls validate IP-literal TLS identity without illegal IP SNI.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import type * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { assertForkRelayHost } from "./forkOwnership.ts";

export const RELAY_MIGRATIONS_TABLE = "relay_migrations";

const DRIZZLE_DIR_PATTERN = /^\d{14}_.+/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const VALID_SSLMODES = new Set([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

export interface PostgresMigrationRecord {
  readonly name: string;
  readonly hash: string;
  readonly createdAtMillis: number | undefined;
  readonly statements: ReadonlyArray<string>;
}

export class PostgresMigrationError extends Schema.TaggedError<PostgresMigrationError>()(
  "PostgresMigrationError",
  {
    operation: Schema.Literals(["read", "query", "apply", "history", "config"]),
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
  /** Override lock acquisition in single-connection test harnesses; production uses `pg_advisory_lock`. */
  readonly withLock?: <A, E>(
    lockKey: string,
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

const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/u.test(ch);

/**
 * Split a PostgreSQL script on top-level `;` while stripping comments and preserving
 * quoted strings (`'...'`, `E'...'`), quoted identifiers (`"..."`), and `$tag$...$tag$`
 * dollar-quoted bodies — matching `@alchemy.run/sql`'s `splitSqlScript(sql, "postgres")`.
 */
export function splitPostgresSqlScript(sql: string): ReadonlyArray<string> {
  const statements: string[] = [];
  let text = "";
  let hasCode = false;

  const push = () => {
    if (hasCode) {
      const trimmed = text.trim();
      if (trimmed.length > 0) statements.push(trimmed);
    }
    text = "";
    hasCode = false;
  };

  let index = 0;
  while (index < sql.length) {
    const ch = sql[index]!;
    const next = sql[index + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      text += " ";
      index = end < 0 ? sql.length : end;
      continue;
    }

    if (ch === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sql.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      text += " ";
      index = cursor;
      continue;
    }

    if (ch === "$" && !isWordChar(sql[index - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u.exec(sql.slice(index))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, index + tag.length);
        const end = close < 0 ? sql.length : close + tag.length;
        text += sql.slice(index, end);
        hasCode = true;
        index = end;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      const prefix =
        /(?:^|[^A-Za-z0-9_])([A-Za-z]{1,2})$/u
          .exec(sql.slice(Math.max(0, index - 3), index))?.[1]
          ?.toLowerCase() ?? "";
      const backslashEscapes = ch === "'" && prefix === "e";
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (backslashEscapes && sql[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === ch) {
          cursor += 1;
          if (sql[cursor] === ch) {
            cursor += 1;
            continue;
          }
          break;
        }
        cursor += 1;
      }
      text += sql.slice(index, cursor);
      hasCode = true;
      index = cursor;
      continue;
    }

    if (ch === ";") {
      push();
      index += 1;
      continue;
    }

    if (!/\s/u.test(ch)) hasCode = true;
    text += ch;
    index += 1;
  }

  push();
  return statements;
}

const aliasesOf = (name: string): ReadonlyArray<string> => [
  name,
  `${name}/migration.sql`,
  name.replace(/\/migration\.sql$/u, ""),
];

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function stripHostBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function formatUrlHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host;
  }
  return host.includes(":") ? `[${host}]` : host;
}

// Match @effect/sql-pg / pg semantics across URL and RELAY_DB_* forms: `require`
// verifies server certificates and hostname so the default public-origin path stays verified.
function resolveSslForMode(
  sslMode: string,
  tlsOriginHost: string | undefined,
): PgClient.PgClientConfig["ssl"] {
  if (sslMode === "disable") return false;
  if (sslMode === "verify-ca") {
    return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
  }
  if (!tlsOriginHost) return true;
  const originHost = stripHostBrackets(tlsOriginHost);
  if (NodeNet.isIP(originHost) !== 0) {
    return {
      rejectUnauthorized: true,
      checkServerIdentity: (_host, cert) => NodeTls.checkServerIdentity(originHost, cert),
    };
  }
  return { rejectUnauthorized: true, servername: originHost };
}

const validateMigrationHost = Effect.fn("RelayMigrations.validateHost")(function* (
  name: string,
  host: string,
) {
  const trimmed = host.trim();
  if (!trimmed) {
    return yield* new PostgresMigrationError({
      operation: "config",
      detail: `${name} must not be empty.`,
    });
  }
  if (isLoopbackHost(trimmed)) {
    return trimmed;
  }
  return yield* Effect.try({
    try: () => assertForkRelayHost(name, trimmed),
    catch: (error) =>
      new PostgresMigrationError({
        operation: "config",
        detail: error instanceof Error ? error.message : `${name} must be a fork-owned host.`,
      }),
  });
});

const optionalTrimmed = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => {
      const trimmed = Option.getOrElse(value, () => "").trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  );

/** Resolve single-session migration PgClient config without printing credentials. */
export const resolveMigrationPgClientConfig = Effect.fn("RelayMigrations.resolveConfig")(
  function* () {
    const explicitUrl = yield* Config.Redacted("RELAY_DATABASE_URL").pipe(
      Config.orElse(() => Config.Redacted("DATABASE_URL")),
      Config.option,
    );
    if (Option.isSome(explicitUrl) && Redacted.value(explicitUrl.value).trim().length > 0) {
      const rawUrl = Redacted.value(explicitUrl.value).trim();
      const parsed = yield* Effect.try({
        try: () => new URL(rawUrl),
        catch: () =>
          new PostgresMigrationError({
            operation: "config",
            detail: "RELAY_DATABASE_URL must be a valid PostgreSQL connection URL.",
          }),
      });
      if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
        return yield* new PostgresMigrationError({
          operation: "config",
          detail: "RELAY_DATABASE_URL must use a postgres:// or postgresql:// scheme.",
        });
      }
      if (parsed.searchParams.has("host")) {
        return yield* new PostgresMigrationError({
          operation: "config",
          detail: "RELAY_DATABASE_URL must not specify a host query parameter.",
        });
      }
      yield* validateMigrationHost("RELAY_DATABASE_URL", parsed.hostname);
      const rawUrlSslModes = parsed.searchParams.getAll("sslmode");
      if (rawUrlSslModes.length > 1) {
        return yield* new PostgresMigrationError({
          operation: "config",
          detail: "RELAY_DATABASE_URL must not specify duplicate sslmode query parameters.",
        });
      }
      if (rawUrlSslModes.length === 1) {
        const rawUrlSslMode = rawUrlSslModes[0]!.trim();
        if (rawUrlSslMode.length === 0) {
          return yield* new PostgresMigrationError({
            operation: "config",
            detail: "RELAY_DATABASE_URL sslmode must not be empty.",
          });
        }
        const urlSslMode = rawUrlSslMode.toLowerCase();
        if (!VALID_SSLMODES.has(urlSslMode)) {
          return yield* new PostgresMigrationError({
            operation: "config",
            detail: `Unsupported RELAY_DATABASE_URL sslmode "${urlSslMode}". Expected one of disable, allow, prefer, require, verify-ca, verify-full.`,
          });
        }
        parsed.searchParams.set("sslmode", urlSslMode);
        const normalizedUrl = parsed.toString();
        if (urlSslMode === "prefer" || urlSslMode === "allow") {
          return {
            url: Redacted.make(normalizedUrl),
          } satisfies PgClient.PgClientConfig;
        }
        return {
          url: Redacted.make(normalizedUrl),
          ssl: resolveSslForMode(urlSslMode, undefined),
        } satisfies PgClient.PgClientConfig;
      }
      return {
        url: Redacted.make(rawUrl),
      } satisfies PgClient.PgClientConfig;
    }

    const relayDbHost = yield* optionalTrimmed("RELAY_DB_HOST");
    if (relayDbHost !== undefined) {
      yield* validateMigrationHost("RELAY_DB_HOST", relayDbHost);
    }
    const targetHost = (yield* optionalTrimmed("RELAY_DB_MIGRATION_TARGET_HOST")) ?? relayDbHost;
    const rawPort =
      (yield* optionalTrimmed("RELAY_DB_MIGRATION_TARGET_PORT")) ??
      (yield* optionalTrimmed("RELAY_DB_PORT"));
    const database = yield* optionalTrimmed("RELAY_DB_NAME");
    const username = yield* optionalTrimmed("RELAY_DB_USER");
    const password = yield* Config.Redacted("RELAY_DB_PASSWORD").pipe(Config.option);
    const sslMode = (
      (yield* optionalTrimmed("RELAY_DB_MIGRATION_SSLMODE")) ?? "require"
    ).toLowerCase();

    if (!targetHost || !database || !username || Option.isNone(password)) {
      return yield* new PostgresMigrationError({
        operation: "config",
        detail:
          "Set RELAY_DATABASE_URL (or RELAY_DB_HOST, RELAY_DB_NAME, RELAY_DB_USER, and RELAY_DB_PASSWORD).",
      });
    }
    const validatedTargetHost = yield* validateMigrationHost(
      "RELAY_DB_MIGRATION_TARGET_HOST",
      targetHost,
    );
    const port = rawPort ? (/^\d+$/u.test(rawPort) ? Number(rawPort) : Number.NaN) : 5432;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      return yield* new PostgresMigrationError({
        operation: "config",
        detail: "Postgres migration port must be a valid TCP port (1-65535).",
      });
    }
    if (!VALID_SSLMODES.has(sslMode)) {
      return yield* new PostgresMigrationError({
        operation: "config",
        detail: `Unsupported RELAY_DB_MIGRATION_SSLMODE "${sslMode}". Expected one of disable, allow, prefer, require, verify-ca, verify-full.`,
      });
    }
    const trimmedPassword = Redacted.value(password.value).trim();
    if (!trimmedPassword) {
      return yield* new PostgresMigrationError({
        operation: "config",
        detail: "RELAY_DB_PASSWORD must not be empty.",
      });
    }

    if (sslMode === "prefer" || sslMode === "allow") {
      const encodedUser = encodeURIComponent(username);
      const encodedPassword = encodeURIComponent(trimmedPassword);
      const encodedDb = encodeURIComponent(database);
      return {
        url: Redacted.make(
          `postgresql://${encodedUser}:${encodedPassword}@${formatUrlHost(validatedTargetHost)}:${port}/${encodedDb}?sslmode=${sslMode}`,
        ),
      } satisfies PgClient.PgClientConfig;
    }

    const tlsOriginHost =
      relayDbHost && !isLoopbackHost(relayDbHost) && isLoopbackHost(validatedTargetHost)
        ? relayDbHost
        : undefined;
    const ssl = resolveSslForMode(sslMode, tlsOriginHost);

    return {
      host: stripHostBrackets(validatedTargetHost),
      port,
      database,
      username,
      password: Redacted.make(trimmedPassword),
      ssl,
    } satisfies PgClient.PgClientConfig;
  },
);

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
      statements: splitPostgresSqlScript(sql),
    });
  }
  return records;
});

const withAdvisoryLock = <A, E>(
  executor: PostgresMigrationExecutor,
  lockKey: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | PostgresMigrationError> =>
  executor.withLock
    ? executor.withLock(lockKey, effect)
    : Effect.acquireUseRelease(
        executor.query("SELECT pg_advisory_lock(hashtextextended($1, 0));", [lockKey]),
        () => effect,
        () =>
          executor
            .query("SELECT pg_advisory_unlock(hashtextextended($1, 0));", [lockKey])
            .pipe(Effect.ignore),
      );

/**
 * Apply pending Drizzle migrations under a Postgres session advisory lock using the
 * same `relay_migrations` schema and SHA-256 bookkeeping as `@alchemy.run/planetscale`,
 * so concurrent deploys serialize and a database can move cleanly between modes.
 */
export const applyRelayPostgresMigrations = Effect.fn("RelayMigrations.apply")(function* (options: {
  readonly executor: PostgresMigrationExecutor;
  readonly records: ReadonlyArray<PostgresMigrationRecord>;
  readonly table?: string;
}) {
  const table = options.table ?? RELAY_MIGRATIONS_TABLE;
  const quoted = quoteIdentifier(table);
  const { executor, records } = options;

  return yield* withAdvisoryLock(
    executor,
    `t3code_relay_migrations:${table}`,
    Effect.gen(function* () {
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
    }),
  );
});
