import * as Schema from "effect/Schema";

import { RunId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const WatchAction = Schema.Literals(["send", "queue", "steer"]);
export type WatchAction = typeof WatchAction.Type;

const watchAdmissionFields = {
  kind: Schema.Literal("watch"),
  expectedProviderInstanceId: Schema.optionalKey(ProviderInstanceId),
  notAfter: Schema.DateTimeUtcFromString,
  steerFollowUpPolicy: Schema.Literal("none"),
};

/** Checked inside the thread dispatch lock, after receipt lookup and before planning. */
export const WatchAdmission = Schema.Union([
  Schema.Struct({
    ...watchAdmissionFields,
    action: Schema.Literal("send"),
    constraint: Schema.Struct({ type: Schema.Literal("requireIdle") }),
  }),
  Schema.Struct({
    ...watchAdmissionFields,
    action: Schema.Literal("queue"),
    constraint: Schema.Struct({ type: Schema.Literal("requireActive") }),
  }),
  Schema.Struct({
    ...watchAdmissionFields,
    action: Schema.Literal("steer"),
    constraint: Schema.Struct({ type: Schema.Literal("requireNativeSteerOf"), targetRunId: RunId }),
  }),
]);
export type WatchAdmission = typeof WatchAdmission.Type;

// Kept independent of orchestrationV2 so Watch DTOs can reuse thread-shell schemas.
export const OrchestrationDispatchAdmission = Schema.Union([WatchAdmission]);
export type OrchestrationDispatchAdmission = typeof OrchestrationDispatchAdmission.Type;
