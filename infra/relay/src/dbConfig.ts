import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import { assertForkRelayHost } from "./forkOwnership.ts";

export type RelayDatabaseMode = "shared-database" | "stage-branch";

export function relayDatabaseMode(stage: string): RelayDatabaseMode {
  return stage === "prod" ? "shared-database" : "stage-branch";
}

export const DEFAULT_RELAY_DB_CLUSTER_SIZE = "PS_5";
export const DEFAULT_RELAY_DB_REPLICAS = 0;
export const DEFAULT_PLANETSCALE_CONNECTION_LIMIT = 40;
export const DEFAULT_EXTERNAL_CONNECTION_LIMIT = 20;
const DEFAULT_POSTGRES_PORT = 5432;

export type RelayDatabaseBackend =
  | {
      readonly kind: "planetscale";
      readonly clusterSize: string;
      readonly replicas: number;
      readonly originConnectionLimit: number;
    }
  | {
      readonly kind: "external";
      readonly origin: Cloudflare.Hyperdrive.PublicOrigin | Cloudflare.Hyperdrive.AccessOrigin;
      readonly databaseName: string;
      readonly originConnectionLimit: number;
    };

const invalidConfig = (message: string) =>
  new Config.ConfigError(new Schema.SchemaError(new SchemaIssue.InvalidValue({ message })));

const optionalTrimmed = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => {
      const trimmed = Option.getOrElse(value, () => "").trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }),
  );

const optionalRedacted = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Config.map((value) => {
      if (Option.isNone(value)) return undefined;
      const trimmed = Redacted.value(value.value).trim();
      return trimmed.length > 0 ? Redacted.make(trimmed) : undefined;
    }),
  );

const parseNonNegativeInt = (name: string, fallback: number, min = 0, max?: number) =>
  Effect.fn(`RelayDb.parse_${name}`)(function* (value: string | undefined) {
    if (value === undefined) return fallback;
    const parsed = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
      return yield* Effect.fail(
        invalidConfig(
          max !== undefined
            ? `${name} must be an integer between ${min} and ${max}.`
            : `${name} must be an integer >= ${min}.`,
        ),
      );
    }
    return parsed;
  });

export const relayDatabaseSizingConfig = Config.all({
  clusterSize: optionalTrimmed("RELAY_DB_CLUSTER_SIZE").pipe(
    Config.map((value) => value ?? DEFAULT_RELAY_DB_CLUSTER_SIZE),
  ),
  replicas: optionalTrimmed("RELAY_DB_REPLICAS").pipe(
    Config.mapEffect(parseNonNegativeInt("RELAY_DB_REPLICAS", DEFAULT_RELAY_DB_REPLICAS)),
  ),
});

const resolveDatabaseBackend = Effect.fn("RelayDb.resolveBackend")(function* (input: {
  readonly host: string | undefined;
  readonly port: string | undefined;
  readonly database: string | undefined;
  readonly user: string | undefined;
  readonly password: Redacted.Redacted<string> | undefined;
  readonly accessClientId: Redacted.Redacted<string> | undefined;
  readonly accessClientSecret: Redacted.Redacted<string> | undefined;
  readonly connectionLimit: string | undefined;
  readonly sizing: { readonly clusterSize: string; readonly replicas: number };
}): Effect.fn.Return<RelayDatabaseBackend, Config.ConfigError> {
  if (input.host === undefined) {
    const originConnectionLimit = yield* parseNonNegativeInt(
      "RELAY_DB_CONNECTION_LIMIT",
      DEFAULT_PLANETSCALE_CONNECTION_LIMIT,
      1,
    )(input.connectionLimit);
    return {
      kind: "planetscale",
      clusterSize: input.sizing.clusterSize,
      replicas: input.sizing.replicas,
      originConnectionLimit,
    };
  }

  const validatedHost = yield* Effect.try({
    try: () => assertForkRelayHost("RELAY_DB_HOST", input.host),
    catch: (error) =>
      invalidConfig(error instanceof Error ? error.message : "RELAY_DB_HOST is invalid."),
  });

  if (input.database === undefined) {
    return yield* Effect.fail(
      invalidConfig("RELAY_DB_NAME is required when RELAY_DB_HOST is set."),
    );
  }
  if (input.user === undefined) {
    return yield* Effect.fail(
      invalidConfig("RELAY_DB_USER is required when RELAY_DB_HOST is set."),
    );
  }
  if (input.password === undefined) {
    return yield* Effect.fail(
      invalidConfig("RELAY_DB_PASSWORD is required when RELAY_DB_HOST is set."),
    );
  }

  const hasAccessId = input.accessClientId !== undefined;
  const hasAccessSecret = input.accessClientSecret !== undefined;
  if (hasAccessId !== hasAccessSecret) {
    return yield* Effect.fail(
      invalidConfig(
        "RELAY_DB_ACCESS_CLIENT_ID and RELAY_DB_ACCESS_CLIENT_SECRET must both be set for Cloudflare Access origins.",
      ),
    );
  }

  const originConnectionLimit = yield* parseNonNegativeInt(
    "RELAY_DB_CONNECTION_LIMIT",
    DEFAULT_EXTERNAL_CONNECTION_LIMIT,
    1,
  )(input.connectionLimit);

  if (hasAccessId && hasAccessSecret) {
    const origin: Cloudflare.Hyperdrive.AccessOrigin = {
      scheme: "postgres",
      host: validatedHost,
      database: input.database,
      user: input.user,
      password: input.password,
      accessClientId: input.accessClientId,
      accessClientSecret: input.accessClientSecret,
    };
    return {
      kind: "external",
      origin,
      databaseName: input.database,
      originConnectionLimit,
    };
  }

  const port = yield* parseNonNegativeInt(
    "RELAY_DB_PORT",
    DEFAULT_POSTGRES_PORT,
    1,
    65535,
  )(input.port);
  const origin: Cloudflare.Hyperdrive.PublicOrigin = {
    scheme: "postgres",
    host: validatedHost,
    port,
    database: input.database,
    user: input.user,
    password: input.password,
  };
  return {
    kind: "external",
    origin,
    databaseName: input.database,
    originConnectionLimit,
  };
});

export const relayDatabaseBackendConfig: Config.Config<RelayDatabaseBackend> = Config.all({
  host: optionalTrimmed("RELAY_DB_HOST"),
  port: optionalTrimmed("RELAY_DB_PORT"),
  database: optionalTrimmed("RELAY_DB_NAME"),
  user: optionalTrimmed("RELAY_DB_USER"),
  password: optionalRedacted("RELAY_DB_PASSWORD"),
  accessClientId: optionalRedacted("RELAY_DB_ACCESS_CLIENT_ID"),
  accessClientSecret: optionalRedacted("RELAY_DB_ACCESS_CLIENT_SECRET"),
  connectionLimit: optionalTrimmed("RELAY_DB_CONNECTION_LIMIT"),
  sizing: relayDatabaseSizingConfig,
}).pipe(Config.mapEffect(resolveDatabaseBackend));
