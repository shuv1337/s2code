// S2Code sends no product analytics. The service stays so upstream call sites merge unchanged.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Whether the event was queued to send; false when telemetry is off. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

const disabled = AnalyticsService.of({
  record: Effect.fn("AnalyticsService.record")(() => Effect.succeed(false)),
  flush: Effect.void,
  recordOwners: Effect.fn("AnalyticsService.recordOwners")(() => Effect.void),
});

/** @public */
export const make = Effect.succeed(disabled);

export const layer: Layer.Layer<AnalyticsService> = Layer.succeed(AnalyticsService, disabled);
