import type {
  OrchestrationV2ProviderFailure,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";

/** Only an explicitly non-retryable usage limit indicates exhausted quota. */
const isQuotaExhausted = (failure: OrchestrationV2ProviderFailure) =>
  failure.class === "usage_limit" && failure.retryable === false;

/** Whether an exhausted quota turns `instance` off: it is an enabled, opted-in pool member. */
export const disablesOnExhaustedQuota = (instance: ProviderInstanceConfig | undefined) =>
  instance?.disableOnUsageLimit === true && instance.enabled !== false;

/** Turns off an opted-in instance whose turn failed on an exhausted quota. */
export const disableInstanceOnExhaustedQuota = Effect.fn(
  "ProviderUsageLimitAutoDisable.disableInstanceOnExhaustedQuota",
)(function* (
  instanceId: ProviderInstanceId,
  failure: OrchestrationV2ProviderFailure,
  account?: string,
) {
  if (!isQuotaExhausted(failure)) return false;
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = (yield* settings.getSettings).providerInstances[instanceId];
  if (current === undefined || !disablesOnExhaustedQuota(current)) return false;
  const at = DateTime.formatIso(yield* DateTime.now);
  yield* settings.updateProviderInstance({
    operation: "upsert",
    instanceId,
    instance: {
      ...current,
      enabled: false,
      usageLimitDisabled: {
        at,
        message: failure.message,
        ...(account === undefined ? {} : { account }),
        ...(failure.resetAt == null ? {} : { resetAt: failure.resetAt }),
      },
    },
  });
  return true;
});
