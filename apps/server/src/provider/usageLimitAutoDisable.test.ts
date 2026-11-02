import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as ServerSettings from "../serverSettings.ts";
import { disableInstanceOnExhaustedQuota } from "./usageLimitAutoDisable.ts";

const optedIn = ProviderInstanceId.make("cursor_pool_opted_in");
const optedOut = ProviderInstanceId.make("cursor_pool_opted_out");
const codex = ProviderInstanceId.make("codex_rate_limited");
const cursor = ProviderDriverKind.make("cursor");
const quotaMessage =
  "Your team has reached its usage limit Please reach out to an admin to enable on-demand usage, or return on 11/4/2026 when your limit resets.";

const layer = ServerSettings.layerTest({
  providerInstances: {
    [codex]: { driver: ProviderDriverKind.make("codex"), enabled: true, disableOnUsageLimit: true },
    [optedIn]: {
      driver: cursor,
      displayName: "Cursor-3",
      enabled: true,
      disableOnUsageLimit: true,
    },
    [optedOut]: { driver: cursor, displayName: "Cursor-4", enabled: true },
  },
});

describe("disableInstanceOnExhaustedQuota", () => {
  it.effect("turns off only opted-in instances whose quota is exhausted", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const instance = (id: ProviderInstanceId) =>
        settings.getSettings.pipe(Effect.map((current) => current.providerInstances[id]));

      for (const [instanceId, failure] of [
        [
          optedIn,
          makeProviderFailure({ class: "usage_limit", message: "Slow down.", retryable: true }),
        ],
        [
          optedIn,
          makeProviderFailure({ class: "provider_error", message: quotaMessage, retryable: false }),
        ],
        [
          optedOut,
          makeProviderFailure({ class: "usage_limit", message: quotaMessage, retryable: false }),
        ],
      ] as const) {
        assert.isFalse(yield* disableInstanceOnExhaustedQuota(instanceId, failure));
      }
      for (const retryable of [null, undefined] as const) {
        const failure = makeProviderFailure({
          class: "usage_limit",
          code: "429",
          message: "Too many requests",
          ...(retryable === undefined ? {} : { retryable }),
        });
        assert.isNull(failure.retryable);
        assert.isFalse(yield* disableInstanceOnExhaustedQuota(codex, failure));
        assert.isTrue((yield* instance(codex))?.enabled);
        assert.isUndefined((yield* instance(codex))?.usageLimitDisabled);
      }
      assert.isTrue((yield* instance(optedIn))?.enabled);
      assert.isTrue((yield* instance(optedOut))?.enabled);

      assert.isTrue(
        yield* disableInstanceOnExhaustedQuota(
          optedIn,
          makeProviderFailure({ class: "usage_limit", message: quotaMessage, retryable: false }),
        ),
      );
      const disabled = yield* instance(optedIn);
      assert.isFalse(disabled?.enabled);
      assert.strictEqual(disabled?.usageLimitDisabled?.message, quotaMessage);
      assert.isTrue(disabled?.disableOnUsageLimit);

      yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: optedIn,
        instance: { ...disabled!, enabled: true },
      });
      const reenabled = yield* instance(optedIn);
      assert.isTrue(reenabled?.enabled);
      assert.isUndefined(reenabled?.usageLimitDisabled);
    }).pipe(Effect.provide(layer)),
  );
});
