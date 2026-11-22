import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  relayDatabaseBackendConfig,
  relayDatabaseMode,
  relayDatabaseSizingConfig,
} from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

export const PlanetscaleDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });

  const mode = relayDatabaseMode(stage);
  const database =
    mode === "shared-database"
      ? yield* Effect.gen(function* () {
          const { clusterSize, replicas } = yield* relayDatabaseSizingConfig;
          return yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
            name: "t3coderelay",
            region: { slug: "us-west" },
            clusterSize,
            migrations: { dir: schema.out, table: "relay_migrations" },
            replicas,
          }).pipe(RemovalPolicy.retain());
        })
      : yield* Planetscale.PostgresDatabase.ref("RelayPostgresDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.PostgresBranch("RelayPostgresBranch", {
          database,
          migrations: { dir: schema.out, table: "relay_migrations" },
        })
      : undefined;

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database,
    ...(branch ? { branch } : {}),
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  return { branch, database, runtimeRole };
});

export const RelayDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const backend = yield* relayDatabaseBackendConfig;
  if (backend.kind === "planetscale") {
    const ps = yield* PlanetscaleDatabase;
    return {
      kind: "planetscale" as const,
      databaseName: ps.database.name,
      databaseBranchName: ps.branch?.name ?? "main",
      origin: ps.runtimeRole.origin,
      originConnectionLimit: backend.originConnectionLimit,
    };
  }
  if (stage !== "prod") {
    return yield* Effect.die(
      new Error(
        `External Postgres mode only supports the "prod" stage (got "${stage}"). Preview stages require PlanetScale branching.`,
      ),
    );
  }
  return {
    kind: "external" as const,
    databaseName: backend.databaseName,
    databaseBranchName: "external",
    origin: backend.origin,
    originConnectionLimit: backend.originConnectionLimit,
  };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const db = yield* RelayDatabase;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: db.origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: db.originConnectionLimit,
  });
});
