import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import {
  DEFAULT_EXTERNAL_CONNECTION_LIMIT,
  DEFAULT_PLANETSCALE_CONNECTION_LIMIT,
  relayDatabaseBackendConfig,
  relayDatabaseSizingConfig,
} from "./dbConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("defaults PlanetScale sizing to single-node PS_5 rather than upstream PS_160", () =>
  Effect.gen(function* () {
    for (const env of [{}, { RELAY_DB_CLUSTER_SIZE: "", RELAY_DB_REPLICAS: "" }]) {
      const sizing = yield* relayDatabaseSizingConfig.pipe(provideEnv(env));
      assert.deepEqual(sizing, { clusterSize: "PS_5", replicas: 0 });
    }
  }),
);

it.effect("accepts explicit PlanetScale cluster sizing and rejects invalid replica counts", () =>
  Effect.gen(function* () {
    const custom = yield* relayDatabaseSizingConfig.pipe(
      provideEnv({ RELAY_DB_CLUSTER_SIZE: "PS_10", RELAY_DB_REPLICAS: "2" }),
    );
    assert.deepEqual(custom, { clusterSize: "PS_10", replicas: 2 });

    for (const bad of ["-1", "1.5", "two"]) {
      const result = yield* relayDatabaseSizingConfig.pipe(
        provideEnv({ RELAY_DB_REPLICAS: bad }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), bad);
    }
  }),
);

it.effect("defaults relayDatabaseBackendConfig to PlanetScale with upstream connection limit", () =>
  Effect.gen(function* () {
    const backend = yield* relayDatabaseBackendConfig.pipe(provideEnv({}));
    assert.deepEqual(backend, {
      kind: "planetscale",
      clusterSize: "PS_5",
      replicas: 0,
      originConnectionLimit: DEFAULT_PLANETSCALE_CONNECTION_LIMIT,
    });
  }),
);

it.effect("builds a PublicOrigin in external mode when Access credentials are unset", () =>
  Effect.gen(function* () {
    const backend = yield* relayDatabaseBackendConfig.pipe(
      provideEnv({
        RELAY_DB_HOST: "pg.s2code.dev",
        RELAY_DB_PORT: "6432",
        RELAY_DB_NAME: "s2coderelay",
        RELAY_DB_USER: "relay",
        RELAY_DB_PASSWORD: "db-password",
      }),
    );
    assert.equal(backend.kind, "external");
    if (backend.kind !== "external") return;
    assert.equal(backend.databaseName, "s2coderelay");
    assert.equal(backend.originConnectionLimit, DEFAULT_EXTERNAL_CONNECTION_LIMIT);
    assert.isFalse("accessClientId" in backend.origin);
    assert.deepEqual(
      { ...backend.origin, password: Redacted.value(backend.origin.password) },
      {
        scheme: "postgres",
        host: "pg.s2code.dev",
        port: 6432,
        database: "s2coderelay",
        user: "relay",
        password: "db-password",
      },
    );
  }),
);

it.effect("builds an AccessOrigin when both Access service token credentials are set", () =>
  Effect.gen(function* () {
    const backend = yield* relayDatabaseBackendConfig.pipe(
      provideEnv({
        RELAY_DB_HOST: "pg.s2code.dev",
        RELAY_DB_NAME: "s2coderelay",
        RELAY_DB_USER: "relay",
        RELAY_DB_PASSWORD: "db-password",
        RELAY_DB_ACCESS_CLIENT_ID: "cf-access-id",
        RELAY_DB_ACCESS_CLIENT_SECRET: "cf-access-secret",
        RELAY_DB_CONNECTION_LIMIT: "12",
      }),
    );
    assert.equal(backend.kind, "external");
    if (backend.kind !== "external") return;
    assert.equal(backend.originConnectionLimit, 12);
    assert.isTrue("accessClientId" in backend.origin);
    if (!("accessClientId" in backend.origin)) return;
    assert.deepEqual(
      {
        ...backend.origin,
        password: Redacted.value(backend.origin.password),
        accessClientId: Redacted.value(backend.origin.accessClientId),
        accessClientSecret: Redacted.value(backend.origin.accessClientSecret),
      },
      {
        scheme: "postgres",
        host: "pg.s2code.dev",
        database: "s2coderelay",
        user: "relay",
        password: "db-password",
        accessClientId: "cf-access-id",
        accessClientSecret: "cf-access-secret",
      },
    );
  }),
);

it.effect("rejects half-set Access credentials, missing DB fields, and upstream DB hosts", () =>
  Effect.gen(function* () {
    const base = {
      RELAY_DB_HOST: "pg.s2code.dev",
      RELAY_DB_NAME: "s2coderelay",
      RELAY_DB_USER: "relay",
      RELAY_DB_PASSWORD: "db-password",
    };
    const invalidCases: ReadonlyArray<Readonly<Record<string, string>>> = [
      { ...base, RELAY_DB_ACCESS_CLIENT_ID: "only-id" },
      { ...base, RELAY_DB_ACCESS_CLIENT_SECRET: "only-secret" },
      { ...base, RELAY_DB_HOST: "db.t3.codes" },
      { ...base, RELAY_DB_HOST: "db.t3coderelay.com" },
      { ...base, RELAY_DB_HOST: "db.example.com" },
      { ...base, RELAY_DB_NAME: "" },
      { ...base, RELAY_DB_USER: "" },
      { ...base, RELAY_DB_PASSWORD: "" },
      { ...base, RELAY_DB_PORT: "70000" },
      { ...base, RELAY_DB_CONNECTION_LIMIT: "0" },
    ];
    for (const env of invalidCases) {
      const result = yield* relayDatabaseBackendConfig.pipe(provideEnv(env), Effect.result);
      assert.isTrue(Result.isFailure(result), JSON.stringify(env));
    }
  }),
);
