import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

// Compile-time guarantee: AnalyticsService.layer has zero service requirements.
const _zeroRequirementLayer: Layer.Layer<AnalyticsService.AnalyticsService> =
  AnalyticsService.layer;
void _zeroRequirementLayer;

it.effect(
  "never sends analytics requests even when telemetry env vars and PostHog config are set",
  () =>
    Effect.gen(function* () {
      let httpCalls = 0;
      const failOnHttp = HttpClient.make(() =>
        Effect.sync(() => {
          httpCalls += 1;
        }).pipe(Effect.andThen(Effect.die(new Error("Unexpected analytics HTTP request")))),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        assert.isFalse(yield* analytics.record("server.boot.heartbeat", { threadCount: 1 }));
        yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        yield* analytics.flush;
      }).pipe(
        Effect.provide(
          AnalyticsService.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  T3CODE_TELEMETRY_ENABLED: true,
                  T3CODE_POSTHOG_KEY: "phc_test_key",
                  T3CODE_POSTHOG_HOST: "https://analytics.example.test",
                }),
              ),
            ),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, failOnHttp)),
          ),
        ),
      );

      assert.equal(httpCalls, 0);
    }),
);

it.effect("never creates an anonymous-id file in the server state directory", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const analytics = yield* AnalyticsService.AnalyticsService;

    assert.isFalse(yield* analytics.record("test.event"));
    yield* analytics.recordOwners([{ source: "device", ownerId: "b".repeat(64) }], "client");
    yield* analytics.flush;

    assert.isFalse(yield* fs.exists(config.anonymousIdPath));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AnalyticsService.layer,
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "s2-zero-telemetry-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
