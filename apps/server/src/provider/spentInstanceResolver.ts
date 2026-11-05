import {
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings as ServerSettingsValue,
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

export const isSpentInstance = (
  settings: Pick<ServerSettingsValue, "providerInstances">,
  instanceId: ProviderInstanceId,
) =>
  Object.hasOwn(settings.providerInstances, instanceId) &&
  settings.providerInstances[instanceId]?.usageLimitDisabled != null;

type Registry = ProviderRegistry.ProviderRegistry["Service"];

// Turns live with the server's provider registry, so every resolver on it rotates a pool together.
const poolTurns = new WeakMap<Registry, Map<ProviderDriverKind, number>>();

const takePoolTurn = (registry: Registry, pool: ProviderDriverKind) =>
  Effect.sync(() => {
    const turns = poolTurns.get(registry) ?? new Map<ProviderDriverKind, number>();
    poolTurns.set(registry, turns);
    const turn = turns.get(pool) ?? 0;
    turns.set(pool, turn + 1);
    return turn;
  });

/**
 * Moves work off a quota-spent instance, or an unnamed pooled thread start, onto the pool member
 * with the most headroom; later turns stay put until that quota runs out. A named instance is
 * binding. Anything else comes back unchanged for the caller to accept or refuse. Without a
 * provider registry nothing moves.
 */
export const makeSpentInstanceResolver = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
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
    const pool = instance?.disableOnUsageLimit === true ? instance.driver : undefined;
    const spent = isSpentInstance(settings, selection.instanceId);
    const poolStart =
      options?.named === undefined &&
      options?.threadStart === true &&
      pool !== undefined &&
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
        const reason =
          pool === undefined
            ? issue
            : options.named.allowPoolFailover
              ? `${issue}, and no other pool instance can take ${selection.model}`
              : `${issue}; pass allowPoolFailover: true to use another pool instance`;
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
      (spent || pool === undefined
        ? pickUsageLimitReplacement(input)
        : pickUsageLimitPoolStart({
            ...input,
            rotation: yield* takePoolTurn(registry.value, pool),
          })) ?? selection;
    yield* log(resolved, spent ? "requested instance is spent" : "pool start");
    return resolved;
  });
});
