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

export type RecordChange = "disable" | "enable";

/**
 * `instance` as `record` leaves it, or undefined when the record does not change it. Run again on
 * the instance as it is when written, so an edit the user made meanwhile is kept, and only the
 * enabled flag and quota note ever change.
 */
export const applyToInstance = (
  record: ProviderAccountUsageLimitRecord,
  change: RecordChange,
  instance: ProviderInstanceConfig | undefined,
): ProviderInstanceConfig | undefined => {
  if (instance === undefined || instance.driver !== record.driver) return undefined;
  const note = instance.usageLimitDisabled;
  if (change === "enable") {
    if (
      instance.enabled !== false ||
      note?.account !== record.account ||
      Date.parse(note.at) > Date.parse(record.changedAt)
    ) {
      return undefined;
    }
    const { usageLimitDisabled: _note, ...rest } = instance;
    return { ...rest, enabled: true };
  }
  if (instance.disableOnUsageLimit !== true || instance.enabled === false || note !== undefined) {
    return undefined;
  }
  return {
    ...instance,
    enabled: false,
    usageLimitDisabled: {
      at: record.changedAt,
      message: record.message ?? DEFAULT_SPENT_MESSAGE,
      account: record.account,
      reportedBy: record.origin.label,
    },
  };
};

/**
 * The account each pool member was last checked against a spent record as: its key, "" when it
 * is signed in without one, or `TURNED_OFF`.
 */
export type CheckedAccounts = Readonly<Record<string, string>>;
const TURNED_OFF = "off";

export interface RecordApplication {
  readonly changes: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly change: RecordChange;
  }>;
  readonly checked: CheckedAccounts;
}

/**
 * A reset turns back on what a quota note for it turned off. A spent account turns off each
 * enabled pool member newly signed in to it, as a local quota failure would; a member that was
 * off when checked and is on again was turned on by the user, and stays on.
 */
export const applyRecord = (input: {
  readonly record: ProviderAccountUsageLimitRecord;
  readonly self: EnvironmentId;
  readonly instances: ProviderInstanceConfigMap;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly checked: CheckedAccounts;
}): RecordApplication => {
  const { record } = input;
  const changes: Array<RecordApplication["changes"][number]> = [];
  if (record.origin.environmentId === input.self) return { changes, checked: input.checked };
  const checked: Record<string, string> = { ...input.checked };
  for (const [key, instance] of Object.entries(input.instances)) {
    const instanceId = key as ProviderInstanceId;
    if (!record.spent) {
      if (applyToInstance(record, "enable", instance) !== undefined) {
        changes.push({ instanceId, change: "enable" });
      }
      continue;
    }
    if (instance.driver !== record.driver || instance.disableOnUsageLimit !== true) continue;
    if (instance.enabled === false) {
      checked[instanceId] = TURNED_OFF;
      continue;
    }
    // Checked once its sign-in probe has finished.
    const provider = input.providers.find((entry) => entry.instanceId === instanceId);
    if (provider === undefined || provider.auth.status === "unknown") continue;
    const account = providerAccountKey(provider) ?? "";
    const previous = input.checked[instanceId];
    checked[instanceId] = account;
    if (previous === TURNED_OFF || previous === account || account !== record.account) continue;
    if (applyToInstance(record, "disable", instance) !== undefined) {
      changes.push({ instanceId, change: "disable" });
    }
  }
  return { changes, checked };
};
