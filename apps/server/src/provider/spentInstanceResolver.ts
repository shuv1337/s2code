import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import { pickUsageLimitPoolStart, pickUsageLimitReplacement } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/**
 * Moves work off a quota-spent instance, or a pooled thread start, onto the pool member with the
 * most headroom; later turns stay put until that quota runs out. Anything else comes back
 * unchanged for the caller to accept or refuse. Without a provider registry nothing moves.
 */
export const makeSpentInstanceResolver = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  return Effect.fn("SpentInstanceResolver.resolve")(function* (
    selection: ModelSelection,
    projectId: ProjectId | null,
    options?: { readonly threadStart?: boolean },
  ) {
    if (Option.isNone(registry)) return selection;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const instance = Object.hasOwn(settings.providerInstances, selection.instanceId)
      ? settings.providerInstances[selection.instanceId]
      : undefined;
    const spent = instance?.usageLimitDisabled != null;
    const poolStart =
      options?.threadStart === true &&
      instance?.disableOnUsageLimit === true &&
      resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId);
    if (!spent && !poolStart) return selection;
    const input = {
      selection,
      providers: yield* registry.value.getProviders,
      settings,
      projectId,
      now: yield* Clock.currentTimeMillis,
    };
    return (spent ? pickUsageLimitReplacement(input) : pickUsageLimitPoolStart(input)) ?? selection;
  });
});
