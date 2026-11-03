import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import { pickUsageLimitReplacement } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/**
 * Moves a selection off an instance auto-disabled for spent quota onto its pool's healthiest peer.
 * Any other selection, or one with no usable peer, comes back unchanged for the caller to accept
 * or refuse. Without a provider registry (narrow test runtimes) nothing moves.
 */
export const makeSpentInstanceResolver = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  return Effect.fn("SpentInstanceResolver.resolve")(function* (
    selection: ModelSelection,
    projectId: ProjectId | null,
  ) {
    if (Option.isNone(registry)) return selection;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const instance = Object.hasOwn(settings.providerInstances, selection.instanceId)
      ? settings.providerInstances[selection.instanceId]
      : undefined;
    if (instance?.usageLimitDisabled == null) return selection;
    return (
      pickUsageLimitReplacement({
        selection,
        providers: yield* registry.value.getProviders,
        settings,
        projectId,
        now: yield* Clock.currentTimeMillis,
      }) ?? selection
    );
  });
});
