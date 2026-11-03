import type {
  EnvironmentId,
  ProviderAccountUsageLimitRecord,
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { providerAccountKey } from "@t3tools/shared/providerAccount";
import * as DateTime from "effect/DateTime";

const DEFAULT_SPENT_MESSAGE = "Usage limit reached.";

/** Whether `next` replaces `current` as an account's state: newer wins, then the larger origin id. */
export const supersedes = (
  next: ProviderAccountUsageLimitRecord,
  current: ProviderAccountUsageLimitRecord | undefined,
): boolean => {
  if (current === undefined) return true;
  const nextMs = Date.parse(next.changedAt);
  const currentMs = Date.parse(current.changedAt);
  return nextMs !== currentMs
    ? nextMs > currentMs
    : next.origin.environmentId > current.origin.environmentId;
};

/**
 * When a change made here takes effect: now, but always after the state it replaces, so a user
 * acting on a state another environment reported wins over it whatever the two clocks say.
 */
export const localChangeTime = (
  nowMs: number,
  current: ProviderAccountUsageLimitRecord | undefined,
): string =>
  DateTime.formatIso(
    DateTime.makeUnsafe(
      current === undefined ? nowMs : Math.max(nowMs, Date.parse(current.changedAt) + 1),
    ),
  );

export interface LocalTransition {
  readonly instanceId: ProviderInstanceId;
  readonly account: string;
  readonly driver: ProviderDriverKind;
  readonly spent: boolean;
  /** When the quota note this transition wrote, or for a re-enable cleared, was stamped. */
  readonly at: string;
  readonly message?: string;
}

/** A note this environment wrote itself, for a quota it saw run out. */
const localNote = (instance: ProviderInstanceConfig) => {
  const note = instance.usageLimitDisabled;
  return note?.account !== undefined && note.reportedBy === undefined && instance.enabled === false
    ? { ...note, account: note.account }
    : undefined;
};

/**
 * Quota notes this environment wrote itself. At startup they cover a change that landed before
 * the previous run recorded it; the caller records one only when nothing newer is known.
 */
export const localSpentNotes = (instances: ProviderInstanceConfigMap): LocalTransition[] =>
  Object.entries(instances).flatMap(([instanceId, instance]) => {
    const note = localNote(instance);
    return note === undefined
      ? []
      : [
          {
            instanceId: instanceId as ProviderInstanceId,
            account: note.account,
            driver: instance.driver,
            spent: true,
            at: note.at,
            message: note.message,
          },
        ];
  });

/**
 * What changed here between two settings snapshots: a quota this environment saw run out, or an
 * instance the user turned back on after one ran out, here or elsewhere. Turning an instance off
 * by hand says nothing about its quota, so it is not a transition.
 */
export const localTransitions = (
  previous: ProviderInstanceConfigMap,
  next: ProviderInstanceConfigMap,
): LocalTransition[] =>
  Object.entries(next).flatMap(([key, instance]): LocalTransition[] => {
    const instanceId = key as ProviderInstanceId;
    const before = previous[instanceId]?.usageLimitDisabled;
    const note = localNote(instance);
    if (note !== undefined && (before?.at !== note.at || before.account !== note.account)) {
      return [
        {
          instanceId,
          account: note.account,
          driver: instance.driver,
          spent: true,
          at: note.at,
          message: note.message,
        },
      ];
    }
    if (
      before?.account !== undefined &&
      instance.usageLimitDisabled === undefined &&
      instance.enabled !== false
    ) {
      return [
        {
          instanceId,
          account: before.account,
          driver: instance.driver,
          spent: false,
          at: before.at,
        },
      ];
    }
    return [];
  });

export interface RecordApplication {
  readonly writes: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }>;
  /** False while an instance that may hold the account has not finished its sign-in probe. */
  readonly settled: boolean;
}

/**
 * The instance writes that bring this environment in line with another environment's record.
 * A spent account turns off each enabled pool member signed in to it, as a local quota failure
 * would; a reset account turns back on what a quota note for it turned off. Instances the user
 * turned off by hand, and instances outside the pool, are left alone.
 */
export const applyRecord = (input: {
  readonly record: ProviderAccountUsageLimitRecord;
  readonly self: EnvironmentId;
  readonly instances: ProviderInstanceConfigMap;
  readonly providers: ReadonlyArray<ServerProvider>;
}): RecordApplication => {
  const { record } = input;
  if (record.origin.environmentId === input.self) return { writes: [], settled: true };
  const writes: Array<RecordApplication["writes"][number]> = [];
  let settled = true;
  for (const [key, instance] of Object.entries(input.instances)) {
    const instanceId = key as ProviderInstanceId;
    if (instance.driver !== record.driver) continue;
    const note = instance.usageLimitDisabled;
    if (!record.spent) {
      if (
        instance.enabled === false &&
        note?.account === record.account &&
        Date.parse(note.at) <= Date.parse(record.changedAt)
      ) {
        const { usageLimitDisabled: _note, ...rest } = instance;
        writes.push({ instanceId, instance: { ...rest, enabled: true } });
      }
      continue;
    }
    if (instance.disableOnUsageLimit !== true || instance.enabled === false || note !== undefined) {
      continue;
    }
    const provider = input.providers.find((entry) => entry.instanceId === instanceId);
    if (provider === undefined || provider.auth.status === "unknown") {
      settled = false;
      continue;
    }
    if (providerAccountKey(provider) !== record.account) continue;
    writes.push({
      instanceId,
      instance: {
        ...instance,
        enabled: false,
        usageLimitDisabled: {
          at: record.changedAt,
          message: record.message ?? DEFAULT_SPENT_MESSAGE,
          account: record.account,
          reportedBy: record.origin.label,
        },
      },
    });
  }
  return { writes, settled };
};
