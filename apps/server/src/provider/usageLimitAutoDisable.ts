import type { OrchestrationV2ProviderFailure, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";

/** Only an explicitly non-retryable usage limit indicates exhausted quota. */
const isQuotaExhausted = (failure: OrchestrationV2ProviderFailure) =>
  failure.class === "usage_limit" && failure.retryable === false;

/** Turns off an opted-in instance whose turn failed on an exhausted quota. */
export const disableInstanceOnExhaustedQuota = Effect.fn(
  "ProviderUsageLimitAutoDisable.disableInstanceOnExhaustedQuota",
)(function* (instanceId: ProviderInstanceId, failure: OrchestrationV2ProviderFailure) {
  if (!isQuotaExhausted(failure)) return false;
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = (yield* settings.getSettings).providerInstances[instanceId];
  if (current?.disableOnUsageLimit !== true || current.enabled === false) return false;
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* settings.updateProviderInstance({
    operation: "upsert",
    instanceId,
    instance: { ...current, enabled: false, usageLimitDisabled: { at, message: failure.message } },
  });
  return true;
});
