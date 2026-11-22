import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as MobileTelemetry from "./mobileTelemetry/MobileTelemetry.ts";
import { isAxiomObservabilityEnabled, relayOtlpTracesConfig } from "./observability.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("enables Axiom only when AXIOM_TOKEN is non-empty", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* isAxiomObservabilityEnabled.pipe(provideEnv({})));
    assert.isFalse(yield* isAxiomObservabilityEnabled.pipe(provideEnv({ AXIOM_TOKEN: "   " })));
    assert.isTrue(yield* isAxiomObservabilityEnabled.pipe(provideEnv({ AXIOM_TOKEN: "xaat-123" })));
  }),
);

it.effect("parses optional self-hosted OTLP trace config and rejects upstream or HTTP URLs", () =>
  Effect.gen(function* () {
    assert.isUndefined(yield* relayOtlpTracesConfig.pipe(provideEnv({})));
    const configured = yield* relayOtlpTracesConfig.pipe(
      provideEnv({
        RELAY_OTLP_TRACES_URL: "https://traces.s2code.dev/v1/traces",
        RELAY_OTLP_TRACES_TOKEN: "otlp-secret",
      }),
    );
    assert.isDefined(configured);
    if (!configured) return;
    assert.equal(configured.url, "https://traces.s2code.dev/v1/traces");
    assert.equal(configured.token ? Redacted.value(configured.token) : undefined, "otlp-secret");

    for (const badUrl of [
      "http://traces.s2code.dev/v1/traces",
      "https://relay.t3.codes/v1/traces",
      "https://user:secret@traces.s2code.dev/v1/traces",
      "https://traces.example.com/v1/traces",
      "https://traces.test/v1/traces",
      "not-a-url",
    ]) {
      const result = yield* relayOtlpTracesConfig.pipe(
        provideEnv({ RELAY_OTLP_TRACES_URL: badUrl }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), badUrl);
    }
  }),
);

it.effect("answers 503 mobile_telemetry_not_configured when Axiom is disabled", () =>
  Effect.gen(function* () {
    const telemetry = yield* MobileTelemetry.MobileTelemetry;
    const request = HttpServerRequest.fromWeb(
      new Request("https://relay.s2code.dev/v1/mobile/observe/proj/logs", { method: "POST" }),
    );
    const response = yield* telemetry.handle(request, { projectId: "proj", signal: "logs" });
    assert.equal(response.status, 503);
  }).pipe(Effect.provide(MobileTelemetry.layerDisabled)),
);
