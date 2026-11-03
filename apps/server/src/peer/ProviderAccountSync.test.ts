import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLink,
  PROVIDER_ACCOUNT_SYNC_MAX_RECORDS,
  ProviderAccountSyncInput,
  type ProviderAccountUsageLimitRecord,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { providerAccountKey } from "@t3tools/shared/providerAccount";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { descriptorOf } from "./PeerLinks.testkit.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as ProviderAccountSync from "./ProviderAccountSync.ts";

const cursor = ProviderDriverKind.make("cursor");
const pooled: ProviderInstanceConfig = { driver: cursor, enabled: true, disableOnUsageLimit: true };
const POOL_EMAIL = "pool@example.test";
const OTHER_EMAIL = "other@example.test";

const providerFor = (
  instanceId: string,
  auth: ServerProvider["auth"] = { status: "authenticated", email: POOL_EMAIL },
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: cursor,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth,
  checkedAt: "2026-11-03T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const decodeSyncInput = Schema.decodeUnknownEffect(ProviderAccountSyncInput);

const accountOf = (email: string) =>
  providerAccountKey({ driver: cursor, auth: { status: "authenticated", email } })!;

interface Peer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly sync: ProviderAccountSync.ProviderAccountSync["Service"];
  readonly capabilities?: { readonly providerAccountSync?: boolean };
}

/**
 * One environment: its own database and settings, a registry of fake signed-in instances, and,
 * when given a peer, a link whose calls land in that peer's `exchange` as `/mcp` would route them.
 */
const makeHost = Effect.fn(function* (input: {
  readonly id: string;
  readonly label: string;
  readonly instances: Record<string, ProviderInstanceConfig>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly peer?: Peer;
  readonly online?: boolean;
}) {
  const environmentId = EnvironmentId.make(input.id);
  const writes = yield* Queue.unbounded<ServerSettings>();
  const writeCount = yield* Ref.make(0);
  const syncs = yield* Queue.unbounded<void>();
  const exchanges = yield* Queue.unbounded<"ok" | "failed">();
  const calls = yield* Ref.make(0);
  const resolves = yield* Ref.make(0);
  const online = yield* Ref.make(input.online ?? true);
  const providers = yield* Ref.make(input.providers);
  const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>({ replay: 1 });
  const watched = yield* Latch.make(true);
  const beforeNextProviders = yield* Ref.make<Effect.Effect<void>>(Effect.void);

  const layerSettings = Layer.effect(
    ServerSettingsModule.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettingsModule.ServerSettingsService;
      const changes = yield* PubSub.unbounded<ServerSettings>();
      const published = <E>(write: Effect.Effect<ServerSettings, E>) =>
        write.pipe(
          Effect.tap((next) => PubSub.publish(changes, next)),
          Effect.tap(() => Ref.update(writeCount, (count) => count + 1)),
          Effect.tap((next) => Queue.offer(writes, next)),
        );
      return ServerSettingsModule.ServerSettingsService.of({
        ...base,
        updateSettings: (patch) => published(base.updateSettings(patch)),
        updateProviderInstance: (mutation, patch) =>
          published(base.updateProviderInstance(mutation, patch)),
        modifyProviderInstance: (instanceId, update) =>
          base
            .modifyProviderInstance(instanceId, update)
            .pipe(Effect.tap((wrote) => (wrote ? published(base.getSettings) : Effect.void))),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(Stream.tap(() => watched.await)),
          ),
        ),
      });
    }),
  ).pipe(
    Layer.provide(
      ServerSettingsModule.ServerSettingsService.layerTest({
        linkedEnvironmentsEnabled: true,
        providerInstances: input.instances,
      }),
    ),
  );

  const peer = input.peer;
  const link: PeerLink | undefined =
    peer === undefined
      ? undefined
      : {
          environmentId: peer.environmentId,
          label: peer.label,
          urls: ["http://peer.test"],
          access: "auto",
          linkedAt: DateTime.makeUnsafe(0),
          expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
          lastReachedAt: null,
          lastError: null,
        };
  const layerLinks = Layer.mock(PeerLinks.PeerLinks)({
    stored: Queue.offer(syncs, undefined).pipe(Effect.as(link === undefined ? [] : [link])),
    resolve: () =>
      link === undefined
        ? Effect.die("resolved a link this host does not have")
        : Ref.update(resolves, (count) => count + 1).pipe(
            Effect.as({
              link,
              url: "http://peer.test",
              token: "peer-token",
              capabilities: {
                repositoryIdentity: true,
                mcpModeLimitHeader: true,
                linkFence: true,
                providerAccountSync: true,
                ...peer?.capabilities,
              },
            }),
          ),
  });
  const layerClient = Layer.mock(PeerMcpClient.PeerMcpClient)({
    call: (call) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1);
        if (peer === undefined || call.tool !== "t3_provider_account_sync") {
          return yield* Effect.die("unexpected peer call");
        }
        if (!(yield* Ref.get(online))) {
          yield* Queue.offer(exchanges, "failed");
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The linked environment stopped answering.",
          });
        }
        const { records } = yield* decodeSyncInput(call.arguments).pipe(Effect.orDie);
        // Decoded from JSON text, as the peer's tool result arrives.
        // oxlint-disable-next-line t3code/no-inline-schema-compile -- the caller picks the schema per call.
        const answer = yield* Schema.decodeEffect(Schema.fromJsonString(call.success))(
          JSON.stringify({
            environmentId: peer.environmentId,
            records: yield* peer.sync.exchange(records),
          }),
        ).pipe(Effect.orDie);
        yield* Queue.offer(exchanges, "ok");
        return answer;
      }),
  });

  const context = yield* ProviderAccountSync.layer.pipe(
    Layer.provideMerge(layerSettings),
    Layer.provide(Sqlite.layerMemory),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Ref.getAndSet(beforeNextProviders, Effect.void).pipe(
            Effect.flatten,
            Effect.andThen(Ref.get(providers)),
          ),
          streamChanges: Stream.fromPubSub(providerChanges),
        }),
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.succeed(descriptorOf(input.id, input.label)),
        }),
        layerLinks,
        layerClient,
      ),
    ),
    Layer.fresh,
    Layer.build,
  );
  const sync = yield* ProviderAccountSync.ProviderAccountSync.pipe(Effect.provide(context));
  const settings = yield* ServerSettingsModule.ServerSettingsService.pipe(Effect.provide(context));
  const instance = (id: string) =>
    settings.getSettings.pipe(
      Effect.orDie,
      Effect.map((current) => current.providerInstances[ProviderInstanceId.make(id)]),
    );
  return {
    environmentId,
    label: input.label,
    sync,
    instance,
    /** Writes the instance as the user, or a quota failure here, would. */
    write: (id: string, next: ProviderInstanceConfig) =>
      settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId: ProviderInstanceId.make(id),
          instance: next,
        })
        .pipe(Effect.orDie),
    setProviders: (next: ReadonlyArray<ServerProvider>) =>
      Ref.set(providers, next).pipe(Effect.andThen(PubSub.publish(providerChanges, next))),
    /** Runs `edit` while the next apply is deciding, after it read settings and before it writes. */
    duringNextApply: (edit: Effect.Effect<unknown>) =>
      Ref.set(beforeNextProviders, Effect.asVoid(edit)),
    /** Waits for the next sync to begin, which follows every record made here. */
    nextSync: Queue.take(syncs),
    /** Waits for the next call to the peer to finish. */
    nextExchange: Queue.take(exchanges),
    nextWrite: Queue.take(writes),
    writeCount: Ref.get(writeCount),
    calls: Ref.get(calls),
    resolves: Ref.get(resolves),
    setOnline: (value: boolean) => Ref.set(online, value),
    /** Holds settings changes back from the service's watcher until `releaseWatcher`. */
    holdWatcher: watched.close,
    releaseWatcher: watched.open,
    records: sync.exchange([]),
  };
});

/** Host B, and host A linked to it; A's startup exchange has finished. */
const linkedHosts = Effect.fn(function* (input: {
  readonly a?: Record<string, ProviderInstanceConfig>;
  readonly aProviders?: ReadonlyArray<ServerProvider>;
  readonly b: Record<string, ProviderInstanceConfig>;
  readonly bProviders: ReadonlyArray<ServerProvider>;
  readonly online?: boolean;
}) {
  const b = yield* makeHost({
    id: "env-b",
    label: "Host B",
    instances: input.b,
    providers: input.bProviders,
  });
  yield* b.nextSync;
  const a = yield* makeHost({
    id: "env-a",
    label: "Host A",
    instances: input.a ?? { cursor_a: pooled },
    providers: input.aProviders ?? [providerFor("cursor_a")],
    peer: b,
    ...(input.online === undefined ? {} : { online: input.online }),
  });
  yield* a.nextExchange;
  return { a, b };
});

const SPENT_AT = "2026-11-03T10:00:00.000Z";
const spentNote = (email = POOL_EMAIL, at = SPENT_AT) => ({
  at,
  message: "You've hit your usage limit.",
  account: accountOf(email),
});

/** A's instance runs out of quota, as the usage-limit auto-disable writes it. */
const spendOn = (
  host: Effect.Success<ReturnType<typeof makeHost>>,
  id: string,
  email = POOL_EMAIL,
  at = SPENT_AT,
) => host.write(id, { ...pooled, enabled: false, usageLimitDisabled: spentNote(email, at) });

it.effect("a spent account turns off only that account's pool members on the linked host", () =>
  Effect.gen(function* () {
    const { a, b } = yield* linkedHosts({
      b: {
        cursor_b: pooled,
        cursor_other: pooled,
        cursor_unpooled: { driver: cursor, enabled: true },
        cursor_off: { ...pooled, enabled: false },
      },
      bProviders: [
        providerFor("cursor_b"),
        providerFor("cursor_other", { status: "authenticated", email: OTHER_EMAIL }),
        providerFor("cursor_unpooled"),
        providerFor("cursor_off"),
      ],
    });

    yield* spendOn(a, "cursor_a");
    expect(yield* a.nextExchange).toBe("ok");

    expect(yield* b.instance("cursor_b")).toEqual({
      ...pooled,
      enabled: false,
      usageLimitDisabled: { ...spentNote(), reportedBy: "Host A" },
    });
    expect(yield* b.instance("cursor_other")).toEqual(pooled);
    expect(yield* b.instance("cursor_unpooled")).toEqual({ driver: cursor, enabled: true });
    expect(yield* b.instance("cursor_off")).toEqual({ ...pooled, enabled: false });

    // Turning on an instance the user had turned off is not fought by later syncs.
    yield* b.write("cursor_off", pooled);
    yield* a.sync.syncNow;
    yield* a.sync.syncNow;
    expect(yield* b.instance("cursor_off")).toEqual(pooled);
  }),
);

it.effect("an apply leaves what the user saved while it was deciding, except the quota", () =>
  Effect.gen(function* () {
    const { a, b } = yield* linkedHosts({
      b: { cursor_b: pooled, cursor_b2: pooled },
      bProviders: [providerFor("cursor_b"), providerFor("cursor_b2")],
    });
    yield* b.duringNextApply(
      Effect.all([
        b.write("cursor_b", { ...pooled, displayName: "Renamed" }),
        b.write("cursor_b2", { ...pooled, enabled: false }),
      ]),
    );

    yield* spendOn(a, "cursor_a");
    yield* a.nextExchange;

    expect(yield* b.instance("cursor_b")).toEqual({
      ...pooled,
      displayName: "Renamed",
      enabled: false,
      usageLimitDisabled: { ...spentNote(), reportedBy: "Host A" },
    });
    expect(yield* b.instance("cursor_b2")).toEqual({ ...pooled, enabled: false });
  }),
);

it.effect(
  "a pool member signed in to a spent account later, or added later, is turned off unless the user turns it on",
  () =>
    Effect.gen(function* () {
      const { a, b } = yield* linkedHosts({
        b: { cursor_b: pooled },
        bProviders: [providerFor("cursor_b", { status: "authenticated", email: OTHER_EMAIL })],
      });
      yield* spendOn(a, "cursor_a");
      yield* a.nextExchange;
      expect(yield* b.instance("cursor_b")).toEqual(pooled);

      const reported = { enabled: false, usageLimitDisabled: { reportedBy: "Host A" } };
      yield* b.setProviders([providerFor("cursor_b")]);
      // An exchange applies what is known, so once it returns the sign-in has been handled.
      yield* b.records;
      expect(yield* b.instance("cursor_b")).toMatchObject(reported);

      yield* b.write("cursor_new", pooled);
      yield* b.setProviders([providerFor("cursor_b"), providerFor("cursor_new")]);
      yield* b.records;
      expect(yield* b.instance("cursor_new")).toMatchObject(reported);

      yield* b.write("cursor_mine", { ...pooled, enabled: false });
      yield* b.setProviders([
        providerFor("cursor_b"),
        providerFor("cursor_new"),
        providerFor("cursor_mine"),
      ]);
      yield* b.records;
      yield* b.write("cursor_mine", pooled);
      yield* b.records;
      expect(yield* b.instance("cursor_mine")).toEqual(pooled);
    }),
);

it.effect("a re-enable on the linked host turns the account back on here, and then settles", () =>
  Effect.gen(function* () {
    const { a, b } = yield* linkedHosts({
      a: { cursor_a: pooled, cursor_marker: pooled },
      aProviders: [
        providerFor("cursor_a"),
        providerFor("cursor_marker", { status: "authenticated", email: OTHER_EMAIL }),
      ],
      b: { cursor_b: pooled },
      bProviders: [providerFor("cursor_b")],
    });
    yield* spendOn(a, "cursor_a");
    yield* a.nextExchange;
    expect((yield* b.instance("cursor_b"))?.enabled).toBe(false);

    yield* b.write("cursor_b", pooled);
    yield* b.nextSync;
    yield* a.sync.syncNow;
    yield* a.nextExchange;
    expect(yield* a.instance("cursor_a")).toEqual(pooled);

    // Settings changes are watched in order, so once this one has synced, the watcher has
    // seen the applied re-enable too, and must not have recorded it as A's own.
    yield* spendOn(a, "cursor_marker", OTHER_EMAIL);
    yield* a.nextExchange;
    const records = yield* a.records;
    expect(records).toMatchObject(
      [
        { account: accountOf(POOL_EMAIL), spent: false, origin: { environmentId: "env-b" } },
        { account: accountOf(OTHER_EMAIL), spent: true, origin: { environmentId: "env-a" } },
      ].toSorted((left, right) => left.account.localeCompare(right.account)),
    );
    expect(yield* b.records).toEqual(records);

    // Neither the applied re-enable nor further syncs echo anything back.
    const writes = { a: yield* a.writeCount, b: yield* b.writeCount };
    yield* a.sync.syncNow;
    yield* a.sync.syncNow;
    yield* b.sync.syncNow;
    expect({ a: yield* a.writeCount, b: yield* b.writeCount }).toEqual(writes);
    expect(yield* a.records).toEqual(records);
    expect(yield* b.records).toEqual(records);
  }),
);

it.effect("an applied re-enable is not the user's, even when a newer spent state lands first", () =>
  Effect.gen(function* () {
    const { a, b } = yield* linkedHosts({
      a: { cursor_a: pooled, cursor_marker: pooled },
      aProviders: [
        providerFor("cursor_a"),
        providerFor("cursor_marker", { status: "authenticated", email: OTHER_EMAIL }),
      ],
      b: { cursor_b: pooled },
      bProviders: [providerFor("cursor_b")],
    });
    yield* spendOn(a, "cursor_a");
    yield* a.nextExchange;
    yield* b.write("cursor_b", pooled);
    yield* b.nextSync;

    // A applies B's re-enable, then B's next spent state, before A's watcher sees either write.
    yield* a.holdWatcher;
    yield* a.sync.syncNow;
    yield* a.nextExchange;
    expect((yield* a.instance("cursor_a"))?.enabled).toBe(true);
    yield* spendOn(b, "cursor_b", POOL_EMAIL, "2026-11-03T11:00:00.000Z");
    yield* b.nextSync;
    yield* a.sync.syncNow;
    yield* a.nextExchange;
    expect(yield* a.instance("cursor_a")).toMatchObject({
      enabled: false,
      usageLimitDisabled: { reportedBy: "Host B" },
    });
    yield* a.releaseWatcher;

    yield* spendOn(a, "cursor_marker", OTHER_EMAIL);
    yield* a.nextExchange;
    expect(yield* a.records).toMatchObject(
      [
        { account: accountOf(POOL_EMAIL), spent: true, origin: { environmentId: "env-b" } },
        { account: accountOf(OTHER_EMAIL), spent: true, origin: { environmentId: "env-a" } },
      ].toSorted((left, right) => left.account.localeCompare(right.account)),
    );
    expect((yield* b.instance("cursor_b"))?.enabled).toBe(false);
  }),
);

it.effect("the newest record wins, and a tie goes to the larger environment id", () =>
  Effect.gen(function* () {
    const host = yield* makeHost({
      id: "env-m",
      label: "Host M",
      instances: {},
      providers: [],
    });
    const account = accountOf(POOL_EMAIL);
    const recordFrom = (
      environmentId: string,
      changedAt: string,
      spent: boolean,
    ): ProviderAccountUsageLimitRecord => ({
      account,
      driver: cursor,
      spent,
      changedAt,
      origin: { environmentId: EnvironmentId.make(environmentId), label: environmentId },
    });
    const current = recordFrom("env-k", "2026-11-03T10:00:00.000Z", true);

    expect(yield* host.sync.exchange([current])).toEqual([current]);
    expect(
      yield* host.sync.exchange([recordFrom("env-z", "2026-11-03T09:00:00.000Z", false)]),
    ).toEqual([current]);
    expect(
      yield* host.sync.exchange([recordFrom("env-a", "2026-11-03T10:00:00.000Z", false)]),
    ).toEqual([current]);
    const tieWinner = recordFrom("env-z", "2026-11-03T10:00:00.000Z", false);
    expect(yield* host.sync.exchange([tieWinner])).toEqual([tieWinner]);
    const newer = recordFrom("env-a", "2026-11-03T11:00:00.000Z", true);
    expect(yield* host.sync.exchange([newer])).toEqual([newer]);
  }),
);

it.effect("hands out only as many of the newest records as a peer accepts", () =>
  Effect.gen(function* () {
    const host = yield* makeHost({ id: "env-m", label: "Host M", instances: {}, providers: [] });
    const records = Array.from(
      { length: PROVIDER_ACCOUNT_SYNC_MAX_RECORDS + 1 },
      (_, index): ProviderAccountUsageLimitRecord => ({
        account: `account-${index}`,
        driver: cursor,
        spent: true,
        changedAt: DateTime.formatIso(DateTime.makeUnsafe(Date.parse(SPENT_AT) + index * 1_000)),
        origin: { environmentId: EnvironmentId.make("env-k"), label: "Host K" },
      }),
    );
    yield* host.sync.exchange(records.slice(0, PROVIDER_ACCOUNT_SYNC_MAX_RECORDS));
    const known = yield* host.sync.exchange(records.slice(PROVIDER_ACCOUNT_SYNC_MAX_RECORDS));

    expect(known).toHaveLength(PROVIDER_ACCOUNT_SYNC_MAX_RECORDS);
    expect(known.map((record) => record.account)).not.toContain("account-0");
  }),
);

it.effect("hosts that could not reach each other converge on the next periodic sync", () =>
  Effect.gen(function* () {
    const { a, b } = yield* linkedHosts({
      a: { cursor_a: pooled, cursor_a2: pooled },
      aProviders: [
        providerFor("cursor_a"),
        providerFor("cursor_a2", { status: "authenticated", email: OTHER_EMAIL }),
      ],
      b: { cursor_b: pooled, cursor_b2: pooled },
      bProviders: [
        providerFor("cursor_b"),
        providerFor("cursor_b2", { status: "authenticated", email: OTHER_EMAIL }),
      ],
      online: false,
    });

    yield* spendOn(a, "cursor_a");
    expect(yield* a.nextExchange).toBe("failed");
    yield* spendOn(b, "cursor_b2", OTHER_EMAIL);
    yield* b.nextSync;
    expect((yield* b.instance("cursor_b"))?.enabled).toBe(true);

    yield* a.setOnline(true);
    yield* TestClock.adjust("60 seconds");
    expect(yield* a.nextExchange).toBe("ok");

    expect(yield* b.instance("cursor_b")).toMatchObject({
      enabled: false,
      usageLimitDisabled: { reportedBy: "Host A" },
    });
    expect(yield* a.instance("cursor_a2")).toMatchObject({
      enabled: false,
      usageLimitDisabled: { account: accountOf(OTHER_EMAIL), reportedBy: "Host B" },
    });
    expect(yield* a.records).toEqual(yield* b.records);
  }),
);

it.effect("a linked host that does not advertise account sync is never called", () =>
  Effect.gen(function* () {
    const b = yield* makeHost({ id: "env-b", label: "Host B", instances: {}, providers: [] });
    const a = yield* makeHost({
      id: "env-a",
      label: "Host A",
      instances: { cursor_a: pooled },
      providers: [providerFor("cursor_a")],
      peer: { ...b, capabilities: { providerAccountSync: false } },
    });
    yield* spendOn(a, "cursor_a");
    yield* a.sync.syncNow;

    expect(yield* a.resolves).toBeGreaterThan(0);
    expect(yield* a.calls).toBe(0);
  }),
);

it.effect("an apply waits for an opted-in instance's sign-in probe, then completes", () =>
  Effect.gen(function* () {
    const { a, b } = yield* linkedHosts({
      b: { cursor_b: pooled },
      bProviders: [providerFor("cursor_b", { status: "unknown" })],
    });

    yield* spendOn(a, "cursor_a");
    yield* a.nextExchange;
    expect(yield* b.instance("cursor_b")).toEqual(pooled);

    yield* b.setProviders([providerFor("cursor_b")]);
    yield* b.nextWrite;
    expect(yield* b.instance("cursor_b")).toMatchObject({
      enabled: false,
      usageLimitDisabled: { account: accountOf(POOL_EMAIL), reportedBy: "Host A" },
    });
  }),
);
