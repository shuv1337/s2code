import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { RelayClientTracer, withRelayClientTracing } from "@t3tools/shared/relayTracing";

import * as Tracing from "./tracing";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

it.effect("never exports mobile relay traces and preserves typed failures", () => {
  expect(Tracing.resolveTracingConfig()).toBeNull();
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  const layerTracing = Tracing.layerFromConfig(
    {
      tracesUrl: "https://traces.example.test/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    },
    {
      appVariant: "test",
      serviceInstanceId: "test-instance",
      serviceVersion: "1.2.3",
    },
  ).pipe(Layer.provide(layerRemoteHttpClient(fetchFn)));
  const failure = { durationNanos: 1n };
  const layerTracedApplication = Layer.effectDiscard(
    Effect.gen(function* () {
      expect(Option.isNone(yield* RelayClientTracer)).toBe(true);
      const exit = yield* Effect.fail(failure).pipe(
        Effect.withSpan("mobile.test.failed-span"),
        withRelayClientTracing,
        Effect.exit,
      );
      const reason = exit._tag === "Failure" ? exit.cause.reasons[0] : undefined;
      if (reason && Cause.isFailReason(reason)) {
        expect(reason.error).toBe(failure);
      } else {
        return yield* Effect.die(new Error("Expected the original typed failure."));
      }
    }),
  ).pipe(Layer.provide(layerTracing));

  return Layer.build(layerTracedApplication).pipe(
    Effect.scoped,
    Effect.andThen(
      Effect.sync(() => {
        expect(fetchFn).not.toHaveBeenCalled();
      }),
    ),
  );
});
