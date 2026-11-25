// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off -- Alchemy provider helpers expose framework-owned any requirements.
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Test from "@alchemy.run/test/Vitest";
import * as Alchemy from "alchemy";
import { KeyPairProvider } from "alchemy/KeyPair";
import { RandomProvider } from "alchemy/Random";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import { capturedEnvKeys, packEnvValue } from "alchemy/RuntimeContext";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import { inMemoryState } from "alchemy/State";
import { assert, describe } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as Context from "effect/Context";
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
  RELAY_DB_PORT: "5432",
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
    "plan phase keeps Axiom and mobile telemetry disabled even when AXIOM_TOKEN is set",
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
        assert.notInclude(envKeys, "ALCHEMY_OTEL_EXPORTERS");
        assert.notInclude(envKeys, "MobileTelemetryAxiomIngestToken_token");
        assert.notInclude(envKeys, "MOBILE_TELEMETRY_RATE_LIMIT");
        assert.notInclude(resourceIds, "RelayTracesDataset");
        assert.notInclude(resourceIds, "MobileSourceMapsBucket");
        assert.include(resourceIds, "RelayPostgresDatabase");
        assert.isFalse(resourceTypes.some((type) => type.startsWith("Axiom.")));
        assert.isFalse(resourceTypes.includes("Cloudflare.R2.Bucket"));
      }),
  );

  test.provider(
    "runtime phase resolves Hyperdrive by LogicalId and keeps OptionalRelayObservability disabled without deploy config",
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

        const stillDisabledObs = yield* OptionalRelayObservability.pipe(
          Effect.provide(baseRuntime),
          Effect.provideService(Cloudflare.WorkerEnvironment, { MobileSourceMapsBucket: {} }),
        );
        assert.isUndefined(stillDisabledObs);
      }),
  );

  test.provider(
    "runtime phase boots full RelayWorker.layer with __ALCHEMY_RUNTIME__ and only runtime bindings",
    () =>
      Effect.gen(function* () {
        const { envKeys: plannedEnvKeys } = yield* planWorker(externalDbEnv);
        // Mirror WorkerBridge: only Worker runtime bindings/vars, never deploy-only credentials.
        const runtimeEnvBindings: Record<string, string> = {
          RELAY_API_ZONE_NAME: packEnvValue(Redacted.make("s2code.dev")),
          RELAY_TUNNEL_ZONE_NAME: packEnvValue(Redacted.make("s2code.dev")),
          CLERK_PUBLISHABLE_KEY: packEnvValue(Redacted.make(VALID_CLERK_KEY)),
          CLERK_SECRET_KEY: packEnvValue(Redacted.make("sk_live_test_secret")),
          CLERK_JWT_AUDIENCE: packEnvValue(Redacted.make("t3-code-relay")),
          APNS_ENABLED: packEnvValue(Redacted.make("false")),
          ApnsDeliveryJobSigningSecret_text: packEnvValue(
            Redacted.make("test-apns-signing-secret"),
          ),
          CloudMintKeyPair_privateKey: packEnvValue(Redacted.make("test-cloud-mint-private")),
          CloudMintKeyPair_publicKey: packEnvValue("test-cloud-mint-public"),
          ManagedEndpointZone_zoneId: packEnvValue("zone-id-test"),
          ManagedEndpointZone_name: packEnvValue("s2code.dev"),
        };
        for (const key of Object.keys(runtimeEnvBindings)) {
          assert.include(plannedEnvKeys, key);
        }

        const runtimeServiceBindings: Record<string, unknown> = {
          ALCHEMY_CLOUDFLARE_ACCOUNT_ID: "771240435fb4f1407f2b4669085dc79d",
          RelayHyperdrive: {
            connectionString: "postgresql://hyperdrive:secret@127.0.0.1:5432/s2coderelay",
            host: "127.0.0.1",
            port: 5432,
            user: "hyperdrive",
            password: "secret",
            database: "s2coderelay",
          },
          HOOK_RATE_LIMIT: { limit: async () => ({ success: true }) },
          HOOK_ENDPOINT_RATE_LIMIT: { limit: async () => ({ success: true }) },
          HookInboxObject: {
            idFromName: (name: string) => ({ name }),
            get: () => ({}),
            getByName: () => ({}),
          },
        };
        const runtimeBindings: Record<string, unknown> = {
          ...runtimeEnvBindings,
          ...runtimeServiceBindings,
        };
        for (const forbidden of DEPLOY_ONLY_FORBIDDEN_KEYS) {
          assert.notProperty(runtimeBindings, forbidden);
        }

        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = globalThis.__ALCHEMY_RUNTIME__;
            globalThis.__ALCHEMY_RUNTIME__ = true;
            return previous;
          }),
          () =>
            Effect.gen(function* () {
              const stack: Omit<Alchemy.StackSpec, "output"> = {
                name: "T3CodeRelay",
                stage: "prod",
                resources: {},
                bindings: {},
                actions: {},
              };
              const queriedConfigKeys: string[] = [];
              const baseRuntimeConfigProvider = ConfigProvider.orElse(
                ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
                reifyBoundConfigProvider(
                  ConfigProvider.fromUnknown(runtimeBindings),
                  runtimeBindings,
                ),
              );
              const recordingConfigProvider = ConfigProvider.make((path) => {
                queriedConfigKeys.push(path.map((segment) => segment.toString()).join("_"));
                return baseRuntimeConfigProvider.load(path);
              });

              const runtimeLayer = RelayWorker.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(Alchemy.Stack, stack),
                    Layer.succeed(StackContext, stack),
                    Layer.succeed(Stage, "prod"),
                    Layer.succeed(Cloudflare.WorkerEnvironment, runtimeBindings),
                    Layer.succeed(
                      Cloudflare.CloudflareEnvironment,
                      Effect.succeed({
                        account: runtimeBindings.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
                      }) as unknown as Cloudflare.CloudflareEnvironment["Service"],
                    ),
                    ConfigProvider.layer(recordingConfigProvider),
                  ),
                ),
              );

              const response = yield* Effect.gen(function* () {
                const worker = yield* RelayWorker.Api;
                const runtimeContext = (
                  worker as unknown as {
                    readonly RuntimeContext: {
                      readonly exports: Effect.Effect<{
                        readonly default: {
                          readonly fetch: (
                            request: Request,
                            env: unknown,
                            ctx: unknown,
                          ) => readonly [Effect.Effect<Response>, Context.Context<never>];
                        };
                      }>;
                    };
                  }
                ).RuntimeContext;
                const exports = yield* runtimeContext.exports;
                const [metadataEffect, services] = exports.default.fetch(
                  new Request("https://relay.s2code.dev/.well-known/oauth-authorization-server"),
                  runtimeBindings,
                  { waitUntil: () => {}, passThroughOnException: () => {} },
                );
                return yield* metadataEffect.pipe(
                  Effect.provideContext(services),
                  Effect.provideService(Cloudflare.WorkerEnvironment, runtimeBindings),
                );
              }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
              assert.equal(response.status, 200);
              const metadata = (yield* Effect.promise(() => response.json())) as {
                readonly issuer?: string;
              };
              assert.equal(metadata.issuer, "https://relay.s2code.dev");

              assert.isAbove(queriedConfigKeys.length, 0);
              for (const forbidden of [
                ...DEPLOY_ONLY_FORBIDDEN_KEYS,
                "PLANETSCALE_ORGANIZATION",
                "CLOUDFLARE_API_TOKEN",
              ]) {
                assert.notInclude(queriedConfigKeys, forbidden);
              }
            }),
          (previous) =>
            Effect.sync(() => {
              globalThis.__ALCHEMY_RUNTIME__ = previous;
            }),
        );
      }),
  );

  test.provider(
    "plan phase binds optional FEEDBACK_GITHUB_TOKEN and rejects upstream FEEDBACK_GITHUB_REPO",
    () =>
      Effect.gen(function* () {
        const { envKeys } = yield* planWorker({
          ...externalDbEnv,
          FEEDBACK_GITHUB_REPO: "shuv1337/s2code",
          FEEDBACK_GITHUB_AUTO_ISSUES: "true",
          FEEDBACK_GITHUB_TOKEN: "github_pat_test_secret",
        });
        assert.include(envKeys, "FEEDBACK_GITHUB_TOKEN");
        assert.include(envKeys, "FEEDBACK_GITHUB_REPO");
        assert.include(envKeys, "FEEDBACK_GITHUB_AUTO_ISSUES");

        const rejected = yield* planWorker({
          ...externalDbEnv,
          FEEDBACK_GITHUB_REPO: "pingdotgg/t3code",
        }).pipe(Effect.exit);
        assert.equal(rejected._tag, "Failure");
      }),
  );
});
