import { resolveProductEnvironment } from "@t3tools/shared/productIdentity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { expect, it } from "@effect/vitest";
import * as DesktopConfig from "./DesktopConfig.ts";

function resolve(env: Record<string, string>) {
  return Effect.gen(function* () {
    return yield* DesktopConfig.DesktopConfig;
  }).pipe(Effect.provide(DesktopConfig.layerTest(resolveProductEnvironment(env))));
}
it.effect("does not inherit upstream home, port or telemetry configuration", () =>
  Effect.gen(function* () {
    const config = yield* resolve({
      T3CODE_HOME: "/upstream",
      T3CODE_PORT: "3773",
      T3CODE_OTLP_TRACES_URL: "https://upstream.invalid",
    });
    expect(Option.isNone(config.t3Home)).toBe(true);
    expect(Option.isNone(config.configuredBackendPort)).toBe(true);
    expect(Option.isNone(config.otlpTracesUrl)).toBe(true);
  }),
);
it.effect("uses explicit fork configuration while keeping development protocol inputs", () =>
  Effect.gen(function* () {
    const config = yield* resolve({
      SHUV2CODE_HOME: "/fork",
      SHUV2CODE_PORT: "4773",
      T3CODE_HOME: "/upstream",
      VITE_DEV_SERVER_URL: "http://localhost:5173",
    });
    expect(Option.getOrNull(config.t3Home)).toBe("/fork");
    expect(Option.getOrNull(config.configuredBackendPort)).toBe(4773);
    expect(Option.isSome(config.devServerUrl)).toBe(true);
  }),
);
