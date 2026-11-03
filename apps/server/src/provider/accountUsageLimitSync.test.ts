import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountUsageLimitRecord,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerProvider,
  type ServerProviderAuth,
} from "@t3tools/contracts";
import { providerAccountKey } from "@t3tools/shared/providerAccount";

import {
  applyRecord,
  localChangeTime,
  localSpentNotes,
  localTransitions,
  supersedes,
} from "./accountUsageLimitSync.ts";

const cursor = ProviderDriverKind.make("cursor");
const codex = ProviderDriverKind.make("codex");
const self = EnvironmentId.make("env-self");
const laptop = EnvironmentId.make("env-laptop");
const vps = EnvironmentId.make("env-vps");
const id = ProviderInstanceId.make;

const auth = (email: string): ServerProviderAuth => ({ status: "authenticated", email });
const keyOf = (email: string, driver = cursor) =>
  providerAccountKey({ driver, auth: auth(email) })!;
const work = keyOf("work@example.test");
const personal = keyOf("personal@example.test");

const T0 = "2026-11-03T10:00:00.000Z";
const T1 = "2026-11-03T11:00:00.000Z";
const T2 = "2026-11-03T12:00:00.000Z";

const record = (
  overrides: Partial<ProviderAccountUsageLimitRecord> = {},
): ProviderAccountUsageLimitRecord => ({
  account: work,
  driver: cursor,
  spent: true,
  changedAt: T1,
  origin: { environmentId: laptop, label: "Laptop" },
  ...overrides,
});

const pooled = (overrides: Partial<ProviderInstanceConfig> = {}): ProviderInstanceConfig => ({
  driver: cursor,
  enabled: true,
  disableOnUsageLimit: true,
  ...overrides,
});

const snapshot = (
  instanceId: string,
  providerAuth: ServerProviderAuth,
  driver = cursor,
): ServerProvider => ({
  instanceId: id(instanceId),
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: providerAuth,
  checkedAt: T0,
  models: [],
  slashCommands: [],
  skills: [],
});

describe("supersedes", () => {
  it.each([
    ["nothing known", record(), undefined, true],
    ["newer", record({ changedAt: T2 }), record(), true],
    ["older", record({ changedAt: T0 }), record(), false],
    [
      "tie, larger origin",
      record({ origin: { environmentId: vps, label: "VPS" } }),
      record(),
      true,
    ],
    [
      "tie, smaller origin",
      record(),
      record({ origin: { environmentId: vps, label: "VPS" } }),
      false,
    ],
    ["identical", record(), record(), false],
    [
      "newer beats a larger origin",
      record({ changedAt: T2 }),
      record({ origin: { environmentId: vps, label: "VPS" } }),
      true,
    ],
  ] as const)("%s", (_name, next, current, expected) => {
    expect(supersedes(next, current)).toBe(expected);
  });
});

describe("localChangeTime", () => {
  const t1 = Date.parse(T1);
  it.each([
    ["nothing known", t1, undefined, T1],
    ["clock ahead of the record", Date.parse(T2), record(), T2],
    ["clock equal to the record", t1, record(), "2026-11-03T11:00:00.001Z"],
    ["clock behind the record", Date.parse(T0), record(), "2026-11-03T11:00:00.001Z"],
  ] as const)("%s", (_name, nowMs, current, expected) => {
    const at = localChangeTime(nowMs, current);
    expect(at).toBe(expected);
    if (current !== undefined) {
      expect(
        supersedes(
          { ...current, changedAt: at, origin: { environmentId: self, label: "Self" } },
          current,
        ),
      ).toBe(true);
    }
  });
});

describe("localTransitions", () => {
  const instance = id("cursor_pool_1");
  const spentHere = pooled({
    enabled: false,
    usageLimitDisabled: { at: T1, message: "Usage limit reached.", account: work },
  });
  const spentElsewhere = pooled({
    enabled: false,
    usageLimitDisabled: {
      at: T1,
      message: "Usage limit reached.",
      account: work,
      reportedBy: "Laptop",
    },
  });

  it.each<[string, ProviderInstanceConfig | undefined, ProviderInstanceConfig, unknown[]]>([
    [
      "a quota note written here",
      pooled(),
      spentHere,
      [{ account: work, driver: cursor, spent: true, at: T1, message: "Usage limit reached." }],
    ],
    [
      "a quota note on a new instance",
      undefined,
      spentHere,
      [{ account: work, driver: cursor, spent: true, at: T1, message: "Usage limit reached." }],
    ],
    [
      "a newer quota note for the same instance",
      spentHere,
      pooled({ ...spentHere, usageLimitDisabled: { ...spentHere.usageLimitDisabled!, at: T2 } }),
      [{ account: work, driver: cursor, spent: true, at: T2, message: "Usage limit reached." }],
    ],
    ["the same quota note again", spentHere, spentHere, []],
    ["a note another environment reported", pooled(), spentElsewhere, []],
    [
      "a quota note without an account",
      pooled(),
      pooled({ enabled: false, usageLimitDisabled: { at: T1, message: "Usage limit reached." } }),
      [],
    ],
    [
      "a quota note on an instance that is still enabled",
      pooled(),
      pooled({ usageLimitDisabled: { at: T1, message: "Usage limit reached.", account: work } }),
      [],
    ],
    [
      "re-enabled after a local quota note",
      spentHere,
      pooled(),
      [{ account: work, driver: cursor, spent: false }],
    ],
    [
      "re-enabled after a reported quota note",
      spentElsewhere,
      pooled(),
      [{ account: work, driver: cursor, spent: false }],
    ],
    [
      "re-enabled after a note without an account",
      pooled({ enabled: false, usageLimitDisabled: { at: T1, message: "Usage limit reached." } }),
      pooled(),
      [],
    ],
    ["turned off by hand", pooled(), pooled({ enabled: false }), []],
    ["turned on by hand", pooled({ enabled: false }), pooled(), []],
  ])("%s", (_name, previous, next, expected) => {
    const before: ProviderInstanceConfigMap =
      previous === undefined ? {} : { [instance]: previous };
    expect(localTransitions(before, { [instance]: next })).toEqual(expected);
  });

  it("reports only notes written here at startup", () => {
    expect(
      localSpentNotes({
        [id("a")]: spentHere,
        [id("b")]: spentElsewhere,
        [id("c")]: pooled({ enabled: false }),
        [id("d")]: pooled(),
      }),
    ).toEqual([
      { account: work, driver: cursor, spent: true, at: T1, message: "Usage limit reached." },
    ]);
  });
});

describe("applyRecord", () => {
  it("turns off only enabled pool members signed in to the spent account", () => {
    const instances: ProviderInstanceConfigMap = {
      [id("work_a")]: pooled({ displayName: "Cursor-1" }),
      [id("work_b")]: pooled({ displayName: "Cursor-7" }),
      [id("work_off")]: pooled({ enabled: false }),
      [id("work_out")]: pooled({ disableOnUsageLimit: false }),
      [id("work_unset")]: { driver: cursor, enabled: true },
      [id("personal")]: pooled(),
      [id("codex")]: pooled({ driver: codex }),
    };
    const providers = [
      snapshot("work_a", auth("work@example.test")),
      snapshot("work_b", auth(" WORK@example.test")),
      snapshot("work_off", auth("work@example.test")),
      snapshot("work_out", auth("work@example.test")),
      snapshot("work_unset", auth("work@example.test")),
      snapshot("personal", auth("personal@example.test")),
      snapshot("codex", auth("work@example.test"), codex),
    ];
    const note = {
      at: T1,
      message: "Team quota spent.",
      account: work,
      reportedBy: "Laptop",
    };
    expect(
      applyRecord({ record: record({ message: "Team quota spent." }), self, instances, providers }),
    ).toEqual({
      writes: [
        {
          instanceId: id("work_a"),
          instance: { ...instances[id("work_a")], enabled: false, usageLimitDisabled: note },
        },
        {
          instanceId: id("work_b"),
          instance: { ...instances[id("work_b")], enabled: false, usageLimitDisabled: note },
        },
      ],
      settled: true,
    });
  });

  it("leaves instances that already carry a quota note alone", () => {
    const noted = pooled({
      enabled: true,
      usageLimitDisabled: { at: T0, message: "Old.", account: work },
    });
    expect(
      applyRecord({
        record: record(),
        self,
        instances: { [id("a")]: noted },
        providers: [snapshot("a", auth("work@example.test"))],
      }),
    ).toEqual({ writes: [], settled: true });
  });

  it("falls back to a default message", () => {
    const { writes } = applyRecord({
      record: record(),
      self,
      instances: { [id("a")]: pooled() },
      providers: [snapshot("a", auth("work@example.test"))],
    });
    expect(writes[0]?.instance.usageLimitDisabled?.message).toBe("Usage limit reached.");
  });

  it("ignores records that originated here", () => {
    expect(
      applyRecord({
        record: record({ origin: { environmentId: self, label: "Self" } }),
        self,
        instances: { [id("a")]: pooled() },
        providers: [snapshot("a", auth("work@example.test"))],
      }),
    ).toEqual({ writes: [], settled: true });
  });

  it("is unsettled while a candidate has not finished its sign-in probe", () => {
    const result = applyRecord({
      record: record(),
      self,
      instances: {
        [id("probing")]: pooled(),
        [id("missing")]: pooled(),
        [id("ready")]: pooled(),
      },
      providers: [
        snapshot("probing", { status: "unknown" }),
        snapshot("ready", auth("work@example.test")),
      ],
    });
    expect(result.settled).toBe(false);
    expect(result.writes.map((write) => write.instanceId)).toEqual([id("ready")]);
  });

  it("settles when candidates are signed out or signed in elsewhere", () => {
    expect(
      applyRecord({
        record: record(),
        self,
        instances: { [id("out")]: pooled(), [id("other")]: pooled() },
        providers: [
          snapshot("out", { status: "unauthenticated" }),
          snapshot("other", auth("personal@example.test")),
        ],
      }),
    ).toEqual({ writes: [], settled: true });
  });

  it("turns back on what a note for the reset account turned off", () => {
    const noted = (account: string, at: string, reportedBy?: string) =>
      pooled({
        enabled: false,
        usageLimitDisabled: {
          at,
          message: "Usage limit reached.",
          account,
          ...(reportedBy === undefined ? {} : { reportedBy }),
        },
      });
    const instances: ProviderInstanceConfigMap = {
      [id("older")]: noted(work, T0),
      [id("same_time")]: noted(work, T1, "VPS"),
      [id("newer")]: noted(work, T2),
      [id("personal")]: noted(personal, T0),
      [id("manual")]: pooled({ enabled: false }),
      [id("enabled")]: pooled(),
      [id("codex")]: { ...noted(work, T0), driver: codex },
    };
    const { usageLimitDisabled: _older, ...older } = instances[id("older")]!;
    const { usageLimitDisabled: _same, ...sameTime } = instances[id("same_time")]!;
    expect(
      applyRecord({ record: record({ spent: false }), self, instances, providers: [] }),
    ).toEqual({
      writes: [
        { instanceId: id("older"), instance: { ...older, enabled: true } },
        { instanceId: id("same_time"), instance: { ...sameTime, enabled: true } },
      ],
      settled: true,
    });
  });
});
