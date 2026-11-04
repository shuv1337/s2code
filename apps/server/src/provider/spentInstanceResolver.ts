import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  pickUsageLimitPoolStart,
  pickUsageLimitReplacement,
  usageLimitInstanceIssue,
} from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

export interface InstanceResolution {
  /** A new thread's first turn: an unnamed pooled selection moves to the member with the most headroom. */
  readonly threadStart?: boolean;
  /** The caller named this instance: work runs there or fails, unless it allowed pool failover. */
  readonly named?: { readonly allowPoolFailover: boolean };
}

class NamedInstanceUnavailable extends Data.TaggedError("NamedInstanceUnavailable")<{
  readonly instanceId: ProviderInstanceId;
  readonly reason: string;
}> {}

/**
 * Moves work off a quota-spent instance, or an unnamed pooled thread start, onto the pool member
 * with the most headroom; later turns stay put until that quota runs out. A named instance is
 * binding. Anything else comes back unchanged for the caller to accept or refuse. Without a
 * provider registry nothing moves.
 */
export const makeSpentInstanceResolver = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const poolStarts = yield* Ref.make(0);
  return Effect.fn("SpentInstanceResolver.resolve")(function* (
    selection: ModelSelection,
    projectId: ProjectId | null,
    options?: InstanceResolution,
  ) {
    if (Option.isNone(registry)) return selection;
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const instance = Object.hasOwn(settings.providerInstances, selection.instanceId)
      ? settings.providerInstances[selection.instanceId]
      : undefined;
    const spent = instance?.usageLimitDisabled != null;
    const poolStart =
      options?.named === undefined &&
      options?.threadStart === true &&
      instance?.disableOnUsageLimit === true &&
      resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId);
    if (options?.named === undefined && !spent && !poolStart) return selection;
    const input = {
      selection,
      providers: yield* registry.value.getProviders,
      settings,
      projectId,
      now: yield* Clock.currentTimeMillis,
    };
    const log = (resolved: ModelSelection, why: string) =>
      Effect.logInfo("Resolved provider instance", {
        requestedInstanceId: selection.instanceId,
        resolvedInstanceId: resolved.instanceId,
        model: selection.model,
        why,
      });

    if (options?.named !== undefined) {
      const issue = usageLimitInstanceIssue(input);
      if (issue === null) return selection;
      const replacement = options.named.allowPoolFailover ? pickUsageLimitReplacement(input) : null;
      if (replacement === null) {
        const pooled = instance?.disableOnUsageLimit === true;
        const reason = options.named.allowPoolFailover
          ? `${issue}, and no other pool instance can take ${selection.model}`
          : pooled
            ? `${issue}; pass allowPoolFailover: true to use another pool instance`
            : issue;
        yield* Effect.logWarning("Requested provider instance is unavailable", {
          requestedInstanceId: selection.instanceId,
          model: selection.model,
          reason,
        });
        return yield* new NamedInstanceUnavailable({ instanceId: selection.instanceId, reason });
      }
      yield* log(replacement, `failover: requested instance ${issue}`);
      return replacement;
    }

    const resolved =
      (spent
        ? pickUsageLimitReplacement(input)
        : pickUsageLimitPoolStart({
            ...input,
            rotation: yield* Ref.getAndUpdate(poolStarts, (count) => count + 1),
          })) ?? selection;
    yield* log(resolved, spent ? "requested instance is spent" : "pool start");
    return resolved;
  });
});
