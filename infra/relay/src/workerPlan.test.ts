// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off -- Alchemy provider helpers expose framework-owned any requirements.
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Test from "@alchemy.run/test/Vitest";
import * as Alchemy from "alchemy";
import { KeyPairProvider } from "alchemy/KeyPair";
import { RandomProvider } from "alchemy/Random";
import { capturedEnvKeys } from "alchemy/RuntimeContext";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State";
import { assert, describe } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayDb from "./db.ts";
import { OptionalRelayObservability } from "./observability.ts";
import * as RelayWorker from "./worker.ts";

const VALID_CLERK_KEY = `pk_live_${btoa("clerk.s2code.dev$")}`;

const basePlanEnv: Record<string, string> = {
  ALCHEMY_PHASE: "plan",
  RELAY_API_ZONE_NAME: "s2code.dev",
  RELAY_TUNNEL_ZONE_NAME: "s2code.dev",
  CLERK_PUBLISHABLE_KEY: VALID_CLERK_KEY,
  CLERK_SECRET_KEY: "sk_live_test_secret",
  CLERK_JWT_AUDIENCE: "t3-code-relay",
  APNS_ENABLED: "false",
};

const externalDbEnv: Record<string, string> = {
  ...basePlanEnv,
  RELAY_DB_HOST: "pg.s2code.dev",
  RELAY_DB_NAME: "s2coderelay",
  RELAY_DB_USER: "relay",
  RELAY_DB_PASSWORD: "super-secret-db-password",
  RELAY_DB_ACCESS_CLIENT_ID: "cf-access-client-id",
  RELAY_DB_ACCESS_CLIENT_SECRET: "cf-access-client-secret",
  RELAY_DB_CONNECTION_LIMIT: "15",
};

const DEPLOY_ONLY_FORBIDDEN_KEYS = [
  "RELAY_DB_HOST",
  "RELAY_DB_PORT",
  "RELAY_DB_NAME",
  "RELAY_DB_USER",
  "RELAY_DB_PASSWORD",
  "RELAY_DB_ACCESS_CLIENT_ID",
  "RELAY_DB_ACCESS_CLIENT_SECRET",
  "RELAY_DB_CONNECTION_LIMIT",
  "RELAY_DB_CLUSTER_SIZE",
  "RELAY_DB_REPLICAS",
  "AXIOM_TOKEN",
  "RELAY_OTLP_TRACES_URL",
  "RELAY_OTLP_TRACES_TOKEN",
] as const;

const { test } = Test.make({
  providers: Layer.mergeAll(
    Axiom.providers(),
    Cloudflare.providers(),
    Drizzle.providers(),
    Planetscale.providers(),
    KeyPairProvider(),
    RandomProvider(),
    FetchHttpClient.layer,
  ),
  state: inMemoryState(),
});

const stubCloudflareEnv = Layer.succeed(
  Cloudflare.CloudflareEnvironment,
  Effect.succeed({
    type: "apiToken" as const,
    apiToken: Redacted.make("test-token"),
    accountId: "771240435fb4f1407f2b4669085dc79d",
    source: { type: "env" as const },
  }),
);

const planWorker = (env: Readonly<Record<string, string>>) => {
  const stack: Omit<Alchemy.StackSpec, "output"> = {
    name: "T3CodeRelay",
    stage: "prod",
    resources: {},
    bindings: {},
    actions: {},
  };
  return Effect.gen(function* () {
    const worker = yield* RelayWorker.Api;
    const propsEnvKeys = Object.keys(worker.Props?.env ?? {});
    const envKeys = [...new Set([...capturedEnvKeys(worker), ...propsEnvKeys])];
    return {
      envKeys,
      resourceIds: Object.keys(stack.resources),
      resourceTypes: Object.values(stack.resources).map((resource) => resource.Type),
    };
  }).pipe(
    Effect.provide(
      RelayWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            stubCloudflareEnv,
            Layer.succeed(Alchemy.Stack, stack),
            Layer.succeed(StackContext, stack),
            Layer.succeed(Stage, "prod"),
            ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
};

describe("RelayWorker plan and runtime isolation", () => {
  test.provider(
    "plan phase with external Postgres and no Axiom captures zero deploy-only credentials and registers no Axiom/R2/PlanetScale resources",
    () =>
      Effect.gen(function* () {
        const { envKeys, resourceIds, resourceTypes } = yield* planWorker(externalDbEnv);
        for (const forbidden of DEPLOY_ONLY_FORBIDDEN_KEYS) {
          assert.notInclude(envKeys, forbidden);
        }
        assert.notInclude(envKeys, "ALCHEMY_OTEL_EXPORTERS");
        assert.include(resourceIds, "RelayHyperdrive");
        assert.notInclude(resourceIds, "MobileSourceMapsBucket");
        assert.isFalse(resourceTypes.some((type) => type.startsWith("Axiom.")));
        assert.isFalse(resourceTypes.some((type) => type.startsWith("Planetscale.")));
        assert.isFalse(resourceTypes.includes("Cloudflare.R2.Bucket"));
      }),
  );

  test.provider(
    "plan phase with optional self-hosted OTLP binds ALCHEMY_OTEL_EXPORTERS without leaking raw RELAY_OTLP_TRACES_* keys",
    () =>
      Effect.gen(function* () {
        const { envKeys, resourceTypes } = yield* planWorker({
          ...externalDbEnv,
          RELAY_OTLP_TRACES_URL: "https://traces.s2code.dev/v1/traces",
          RELAY_OTLP_TRACES_TOKEN: "otlp-bearer-secret",
        });
        for (const forbidden of DEPLOY_ONLY_FORBIDDEN_KEYS) {
          assert.notInclude(envKeys, forbidden);
        }
        assert.include(envKeys, "ALCHEMY_OTEL_EXPORTERS");
        assert.include(envKeys, "OTEL_SERVICE_NAME");
        assert.isFalse(resourceTypes.some((type) => type.startsWith("Axiom.")));
        assert.isFalse(resourceTypes.includes("Cloudflare.R2.Bucket"));
      }),
  );

  test.provider(
    "plan phase with AXIOM_TOKEN matches upstream scoped ingest bindings and never leaks AXIOM_TOKEN or RELAY_DB_*",
    () =>
      Effect.gen(function* () {
        const { envKeys, resourceIds, resourceTypes } = yield* planWorker({
          ...basePlanEnv,
          PLANETSCALE_ORGANIZATION: "shuv-org",
          RELAY_DB_CLUSTER_SIZE: "PS_5",
          RELAY_DB_REPLICAS: "0",
          AXIOM_TOKEN: "xaat-org-level-deploy-token",
        });
        for (const forbidden of DEPLOY_ONLY_FORBIDDEN_KEYS) {
          assert.notInclude(envKeys, forbidden);
        }
        assert.include(envKeys, "ALCHEMY_OTEL_EXPORTERS");
        assert.include(envKeys, "MobileTelemetryAxiomIngestToken_token");
        assert.include(resourceIds, "RelayTracesDataset");
        assert.include(resourceIds, "MobileSourceMapsBucket");
        assert.include(resourceIds, "RelayPostgresDatabase");
        assert.isTrue(resourceTypes.includes("Cloudflare.R2.Bucket"));
      }),
  );

  test.provider(
    "runtime phase resolves Hyperdrive by LogicalId and detects mobile telemetry from WorkerEnvironment without deploy config",
    () =>
      Effect.gen(function* () {
        const stack: Omit<Alchemy.StackSpec, "output"> = {
          name: "T3CodeRelay",
          stage: "prod",
          resources: {},
          bindings: {},
          actions: {},
        };
        const baseRuntime = Layer.mergeAll(
          stubCloudflareEnv,
          Layer.succeed(Alchemy.Stack, stack),
          Layer.succeed(StackContext, stack),
          Layer.succeed(Stage, "prod"),
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ALCHEMY_PHASE: "runtime" } })),
        );
        const hyperdrive = yield* RelayDb.RelayHyperdrive.pipe(Effect.provide(baseRuntime));
        assert.equal(hyperdrive.LogicalId, "RelayHyperdrive");

        const disabledObs = yield* OptionalRelayObservability.pipe(
          Effect.provide(baseRuntime),
          Effect.provideService(Cloudflare.WorkerEnvironment, {}),
        );
        assert.isUndefined(disabledObs);

        const enabledObs = yield* OptionalRelayObservability.pipe(
          Effect.provide(baseRuntime),
          Effect.provideService(Cloudflare.WorkerEnvironment, { MobileSourceMapsBucket: {} }),
        );
        assert.isDefined(enabledObs);
      }),
  );
});
