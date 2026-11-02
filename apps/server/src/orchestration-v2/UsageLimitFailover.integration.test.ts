import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { disableInstanceOnExhaustedQuota } from "../provider/usageLimitAutoDisable.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UsageLimitFailoverWorker from "./UsageLimitFailoverWorker.ts";

const cursor = ProviderDriverKind.make("cursor");
const codex = ProviderDriverKind.make("codex");
const model = "claude-opus-5-5";
const instance = (name: string) => ProviderInstanceId.make(name);

const spent = instance("cursor_spent");
const busy = instance("cursor_busy");
const fresh = instance("cursor_fresh");
const manual = instance("cursor_manual");
const reserve = instance("cursor_reserve");
// A second, independent pool: its failover is the barrier that proves the worker has already
// decided about every earlier failure, since it handles failure events in commit order.
const sentinelSource = instance("codex_sentinel_source");
const sentinelTarget = instance("codex_sentinel_target");

interface PoolMember {
  readonly driver: ProviderDriverKind;
  readonly usedPercent: number;
  readonly enabled?: boolean;
  /** The provider rejects every turn on this instance with this failure. */
  readonly failure?: OrchestrationV2ProviderFailure;
  /** Turns on this instance stay in flight until this opens. */
  readonly gate?: Deferred.Deferred<void>;
}

const quotaSpent = makeProviderFailure({
  class: "usage_limit",
  message: "You've hit your usage limit.",
  code: "usage_limit",
  retryable: false,
});

const sentinelPool: Record<string, PoolMember> = {
  [sentinelSource]: { driver: codex, usedPercent: 100, failure: quotaSpent },
  [sentinelTarget]: { driver: codex, usedPercent: 0 },
};

const selection = (instanceId: ProviderInstanceId): ModelSelection => ({ instanceId, model });

const layerPlatform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-usage-limit-failover-",
});
const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatform),
    ),
  ),
);

/** The provider boundary: a CLI that streams a turn and then either completes or fails it. */
const makeProviderInstance = (
  instanceId: ProviderInstanceId,
  member: PoolMember,
  startedTurns: Ref.Ref<ReadonlyArray<ProviderInstanceId>>,
): ProviderInstance => {
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver: member.driver,
    getCapabilities: () => Effect.succeed(AcpProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const unused = () => Effect.die("unused by the failover tests");
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId,
          driver: member.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver: member.driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
            model,
            capabilities: AcpProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${instanceId}:${threadInput.threadId}`),
              driver: member.driver,
              providerInstanceId: instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: member.driver,
                nativeId: `${instanceId}:${threadInput.threadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              contextUsage: null,
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          compactThread: unused,
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(startedTurns, (started) => [...started, instanceId]);
              if (member.gate !== undefined) yield* Deferred.await(member.gate);
              const at = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${instanceId}:${turnInput.runId}`,
              );
              const status = member.failure === undefined ? "completed" : "failed";
              const publish = (event: ProviderAdapter.ProviderAdapterV2Event) =>
                PubSub.publish(events, event);
              yield* publish({
                type: "provider_turn.updated",
                driver: member.driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    driver: member.driver,
                    nativeId: `native-turn:${turnInput.runId}`,
                    strength: "strong",
                  },
                  ordinal: turnInput.runOrdinal,
                  status,
                  startedAt: at,
                  completedAt: at,
                },
              });
              yield* publish({
                type: "turn_item.updated",
                driver: member.driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:${instanceId}:${turnInput.runId}`),
                  threadId: turnInput.threadId,
                  runId: turnInput.runId,
                  nodeId: turnInput.rootNodeId,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turnInput.runOrdinal * 100 + 1,
                  status,
                  title: null,
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(`message:${instanceId}:${turnInput.runId}`),
                  text: `Partial work from ${instanceId}`,
                  streaming: false,
                },
              });
              yield* publish({
                type: "turn.terminal",
                driver: member.driver,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                ...(member.failure === undefined
                  ? { status: "completed", failure: null }
                  : {
                      status: "failed",
                      failureItemOrdinal: turnInput.runOrdinal * 100 + 2,
                      failure: member.failure,
                    }),
                threadDisposition: "reusable",
              });
            }).pipe(Effect.forkDetach, Effect.asVoid),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: unused,
          rollbackThread: unused,
          forkThread: unused,
        };
        return runtime;
      }),
  };
  return {
    instanceId,
    driverKind: member.driver,
    continuationIdentity: { driverKind: member.driver, continuationKey: `account:${instanceId}` },
    displayName: undefined,
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
};

const serverProvider = (
  instanceId: ProviderInstanceId,
  member: PoolMember,
  enabled: boolean,
): ServerProvider => ({
  instanceId,
  driver: member.driver,
  enabled,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T00:00:00.000Z",
  models: [{ slug: model, name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-11-02T00:00:00.000Z",
    windows: [
      {
        id: "apiPercentUsed",
        kind: "monthly",
        label: "API",
        usedPercent: member.usedPercent,
      },
    ],
  },
});

/** One server boot; a restart is another boot over the same database file. */
interface Boot {
  readonly databasePath?: string;
  readonly startedTurns?: Ref.Ref<ReadonlyArray<ProviderInstanceId>>;
  /** A boot without a worker stands for a server that went down before it acted. */
  readonly failoverWorker?: boolean;
  readonly effectWorker?: boolean;
}

/**
 * The real orchestrator, ingestor, effect worker, dispatch chokepoint and failover worker over a
 * real database; only the provider instances and their usage snapshots are stand-ins.
 */
const runPool = <A, E, R>(
  pool: Record<string, PoolMember>,
  body: (input: {
    readonly startedTurns: Ref.Ref<ReadonlyArray<ProviderInstanceId>>;
  }) => Effect.Effect<A, E, R>,
  boot: Boot = {},
) =>
  Effect.gen(function* () {
    const startedTurns =
      boot.startedTurns ?? (yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]));
    const members = Object.entries({ ...pool, ...sentinelPool }).map(
      ([name, member]) => [instance(name), member] as const,
    );
    const layerInstances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(
          members
            .filter(([id]) => id === instanceId)
            .map(([id, member]) => makeProviderInstance(id, member, startedTurns))[0],
        ),
      listInstances: Effect.succeed(
        members.map(([id, member]) => makeProviderInstance(id, member, startedTurns)),
      ),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    });
    const layerSettings = ServerSettings.layerTest({
      providerInstances: Object.fromEntries(
        members.map(([id, member]) => [
          id,
          {
            driver: member.driver,
            enabled: member.enabled ?? true,
            disableOnUsageLimit: true,
          },
        ]),
      ),
    });
    // Like the live registry, snapshots follow the settings: a disabled instance reports disabled.
    const layerProviders = Layer.unwrap(
      ServerSettings.ServerSettingsService.use((settings) =>
        Effect.succeed(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: settings.getSettings.pipe(
              Effect.map(({ providerInstances }) =>
                members.map(([id, member]) =>
                  serverProvider(id, member, providerInstances[id]?.enabled !== false),
                ),
              ),
              Effect.orDie,
            ),
          }),
        ),
      ),
    );
    const layerRuntime = Layer.mergeAll(
      RuntimeLayer.layer,
      RuntimeLayer.layerEventSink,
      ProjectStore.layer,
      boot.failoverWorker === false
        ? Layer.empty
        : UsageLimitFailoverWorker.layer.pipe(Layer.provide(RuntimeLayer.layer)),
    ).pipe(
      Layer.provide(McpSessionRegistryTestkit.layer),
      Layer.provide(McpProviderSessions.layer),
      Layer.provide(
        boot.databasePath === undefined
          ? SqlitePersistence.layerMemory
          : SqlitePersistence.layerFromPath(boot.databasePath),
      ),
      Layer.provide(layerCheckpointStore),
      Layer.provide(layerServerConfig),
      Layer.provide(layerInstances),
      Layer.provide(
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree: () => Effect.succeed({} as never),
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
      ),
      Layer.provide(layerPlatform),
      Layer.provideMerge(layerProviders.pipe(Layer.provideMerge(layerSettings))),
    );
    return yield* Effect.gen(function* () {
      // Production starts the daemon from server startup, not from the runtime layer.
      if (boot.effectWorker !== false) yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
      return yield* body({ startedTurns });
    }).pipe(Effect.provide(layerRuntime));
  }).pipe(Effect.scoped);

const send = (
  threadId: ThreadId,
  id: string,
  text: string,
  options: {
    readonly modelSelection?: ModelSelection;
    readonly manualContinuationOfRunId?: RunId;
    readonly queue?: boolean;
  } = {},
) =>
  ThreadManagementService.ThreadManagementService.use((threads) =>
    threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId,
      text,
      attachments: [],
      dispatchMode: { type: options.queue ? "queue_after_active" : "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
      ...(options.manualContinuationOfRunId === undefined
        ? {}
        : { manualContinuationOfRunId: options.manualContinuationOfRunId }),
    }),
  );

const startThread = Effect.fn("UsageLimitFailoverTest.startThread")(function* (
  name: string,
  instanceId: ProviderInstanceId,
  workspaceRoot?: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const now = DateTime.formatIso(yield* DateTime.now);
  const projectId = ProjectId.make(`project:${name}`);
  const threadId = ThreadId.make(`thread:${name}`);
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`seed:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: name,
      workspaceRoot: workspaceRoot ?? (yield* checkpointWorkspace(name)),
      defaultModelSelection: selection(instanceId),
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId,
    title: name,
    modelSelection: selection(instanceId),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* send(threadId, `${name}:first`, "Do the work.");
  return threadId;
});

const awaitThread = Effect.fn("UsageLimitFailoverTest.awaitThread")(function* (
  threadId: ThreadId,
  ready: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(threadId);
  if (ready(current)) return current;
  const [match] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    Stream.filter(ready),
    Stream.take(1),
    Stream.runCollect,
  );
  return match ?? (yield* Effect.die("The event stream ended before the thread was ready."));
});

const idle = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.every((run) => ["completed", "failed", "interrupted"].includes(run.status));
const settled = (runs: number) => (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.length === runs && idle(projection);

/** Resolves once the worker has handled every failure committed before this call. */
const awaitFailoverWorkerCaughtUp = Effect.gen(function* () {
  const threadId = yield* startThread("sentinel", sentinelSource);
  yield* awaitThread(threadId, settled(2));
});

const instanceSettings = (instanceId: ProviderInstanceId) =>
  ServerSettings.ServerSettingsService.use((settings) => settings.getSettings).pipe(
    Effect.map(({ providerInstances }) => providerInstances[instanceId]),
  );

describe("usage limit failover through the real runtime", () => {
  it.live("hands off to the pool member with the most headroom, once per chain", () =>
    runPool(
      {
        [spent]: { driver: cursor, usedPercent: 100, failure: quotaSpent },
        [busy]: { driver: cursor, usedPercent: 80 },
        [fresh]: { driver: cursor, usedPercent: 10, failure: quotaSpent },
      },
      ({ startedTurns }) =>
        Effect.gen(function* () {
          const threadId = yield* startThread("headroom", spent);
          const thread = yield* awaitThread(threadId, settled(2));
          yield* awaitFailoverWorkerCaughtUp;

          const [first, second] = thread.runs;
          assert.deepEqual([first?.providerInstanceId, first?.status], [spent, "failed"]);
          // The least used member took over, although "cursor_busy" sorts first by name.
          assert.deepEqual([second?.providerInstanceId, second?.status], [fresh, "failed"]);
          assert.equal(second?.userMessageId, `usage-limit-failover:${first?.id}`);
          assert.equal(thread.thread.modelSelection.instanceId, fresh);

          // The target spent its quota too, yet the chain stopped: nobody else was asked.
          const after = yield* Orchestrator.OrchestratorV2.use((o) =>
            o.getThreadProjection(threadId),
          );
          assert.lengthOf(after.runs, 2);
          assert.deepEqual(yield* Ref.get(startedTurns), [
            spent,
            fresh,
            sentinelSource,
            sentinelTarget,
          ]);
          assert.isFalse((yield* instanceSettings(busy))?.enabled === false);
        }),
    ),
  );

  it.live("never picks a hand-disabled member, and that member keeps refusing work", () =>
    runPool(
      {
        [spent]: { driver: cursor, usedPercent: 100, failure: quotaSpent },
        [busy]: { driver: cursor, usedPercent: 80 },
        [manual]: { driver: cursor, usedPercent: 0, enabled: false },
      },
      ({ startedTurns }) =>
        Effect.gen(function* () {
          const threadId = yield* startThread("manual", spent);
          const thread = yield* awaitThread(threadId, settled(2));

          // "cursor_manual" has the most headroom but is switched off by hand.
          assert.deepEqual(
            thread.runs.map((run) => [run.providerInstanceId, run.status]),
            [
              [spent, "failed"],
              [busy, "completed"],
            ],
          );

          const refused = yield* send(threadId, "manual:retry", "Try it here.", {
            modelSelection: selection(manual),
          }).pipe(Effect.flip);
          assert.equal(refused._tag, "ThreadManagementProviderInstanceDisabledError");
          assert.lengthOf(
            (yield* Orchestrator.OrchestratorV2.use((o) => o.getThreadProjection(threadId))).runs,
            2,
          );
          assert.notInclude(yield* Ref.get(startedTurns), manual);
          // Only a quota auto-disable leaves a note; this instance never gets one.
          const saved = yield* instanceSettings(manual);
          assert.deepEqual([saved?.enabled, saved?.usageLimitDisabled], [false, undefined]);
        }),
    ),
  );

  it.live.each([
    ["retryable", true],
    ["unmarked", null],
  ] as const)("does not fail over a %s usage limit", ([, retryable]) =>
    runPool(
      {
        [spent]: {
          driver: cursor,
          usedPercent: 100,
          failure: makeProviderFailure({
            class: "usage_limit",
            message: "Rate limited, try again shortly.",
            retryable,
          }),
        },
        [fresh]: { driver: cursor, usedPercent: 10 },
      },
      ({ startedTurns }) =>
        Effect.gen(function* () {
          const threadId = yield* startThread("transient", spent);
          yield* awaitThread(threadId, idle);
          yield* awaitFailoverWorkerCaughtUp;

          const after = yield* Orchestrator.OrchestratorV2.use((o) =>
            o.getThreadProjection(threadId),
          );
          assert.deepEqual(
            after.runs.map((run) => [run.providerInstanceId, run.status]),
            [[spent, "failed"]],
          );
          assert.deepEqual(yield* Ref.get(startedTurns), [spent, sentinelSource, sentinelTarget]);
          // The quota is not spent, so the instance stays available.
          assert.isUndefined((yield* instanceSettings(spent))?.usageLimitDisabled);
        }),
    ),
  );

  it.live("keeps a chain from hopping again when the user resumes the failed-over run", () =>
    runPool(
      {
        [spent]: { driver: cursor, usedPercent: 100, failure: quotaSpent },
        [fresh]: { driver: cursor, usedPercent: 10, failure: quotaSpent },
        [busy]: { driver: cursor, usedPercent: 80, failure: quotaSpent },
        [reserve]: { driver: cursor, usedPercent: 90 },
      },
      ({ startedTurns }) =>
        Effect.gen(function* () {
          const threadId = yield* startThread("chain", spent);
          const [first, second] = (yield* awaitThread(threadId, settled(2))).runs;
          // The dispatch chokepoint moves the resume off the now auto-disabled "cursor_fresh".
          yield* send(threadId, "chain:resume", "Try again.", {
            manualContinuationOfRunId: second!.id,
          });
          yield* awaitThread(threadId, settled(3));
          yield* awaitFailoverWorkerCaughtUp;

          const after = yield* Orchestrator.OrchestratorV2.use((o) =>
            o.getThreadProjection(threadId),
          );
          assert.deepEqual(
            after.runs.map((run) => [run.providerInstanceId, run.status, run.failoverChainId]),
            [
              [spent, "failed", undefined],
              [fresh, "failed", first!.id],
              [busy, "failed", first!.id],
            ],
          );
          assert.notInclude(yield* Ref.get(startedTurns), reserve);
        }),
    ),
  );

  it.live("leaves a snoozed thread asleep on its spent instance", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const snoozedUntil = "2099-01-01T00:00:00.000Z";
      yield* runPool(
        {
          [spent]: { driver: cursor, usedPercent: 100, failure: quotaSpent, gate },
          [fresh]: { driver: cursor, usedPercent: 10 },
        },
        () =>
          Effect.gen(function* () {
            const threadId = yield* startThread("snoozed", spent);
            yield* Orchestrator.OrchestratorV2.use((o) =>
              o.dispatch({
                type: "thread.snooze",
                commandId: CommandId.make("snoozed:snooze"),
                threadId,
                snoozedUntil,
              }),
            );
            yield* Deferred.succeed(gate, undefined);
            yield* awaitThread(threadId, idle);
            yield* awaitFailoverWorkerCaughtUp;

            const after = yield* Orchestrator.OrchestratorV2.use((o) =>
              o.getThreadProjection(threadId),
            );
            assert.deepEqual(
              after.runs.map((run) => [run.providerInstanceId, run.status]),
              [[spent, "failed"]],
            );
            assert.equal(
              after.thread.snoozedUntil && DateTime.formatIso(after.thread.snoozedUntil),
              snoozedUntil,
            );
          }),
      );
    }),
  );

  it.live("starts a queued run on a pooled peer once its instance spent its quota", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* runPool(
        {
          [spent]: { driver: cursor, usedPercent: 50, gate },
          [fresh]: { driver: cursor, usedPercent: 10 },
        },
        () =>
          Effect.gen(function* () {
            const threadId = yield* startThread("queued", spent);
            yield* send(threadId, "queued:next", "Then this.", { queue: true });
            // Another thread spends the shared quota while this one still works.
            assert.isTrue(yield* disableInstanceOnExhaustedQuota(spent, quotaSpent));
            yield* Deferred.succeed(gate, undefined);

            const thread = yield* awaitThread(threadId, settled(2));
            assert.deepEqual(
              thread.runs.map((run) => [run.providerInstanceId, run.status]),
              [
                [spent, "completed"],
                [fresh, "completed"],
              ],
            );
          }),
      );
    }),
  );

  it.live("fails over a failure the server missed while down, once across restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-failover-restart-" });
      const boot = {
        databasePath: `${directory}/state.sqlite`,
        startedTurns: yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]),
      };
      const pool = {
        [spent]: { driver: cursor, usedPercent: 100, failure: quotaSpent },
        [fresh]: { driver: cursor, usedPercent: 10 },
      };
      const threadId = ThreadId.make("thread:restart");
      const workspaceRoot = yield* checkpointWorkspace("restart");

      // Down before the failover worker saw the failure.
      yield* runPool(
        pool,
        () =>
          startThread("restart", spent, workspaceRoot).pipe(
            Effect.andThen((id) => awaitThread(id, settled(1))),
          ),
        { ...boot, failoverWorker: false },
      );
      // Up just long enough for the startup sweep to commit the failover, never starting its turn.
      yield* runPool(pool, () => awaitThread(threadId, (thread) => thread.runs.length === 2), {
        ...boot,
        effectWorker: false,
      });
      const thread = yield* runPool(
        pool,
        () => awaitThread(threadId, settled(2)).pipe(Effect.tap(() => awaitFailoverWorkerCaughtUp)),
        boot,
      );

      assert.deepEqual(
        thread.runs.map((run) => [run.providerInstanceId, run.status]),
        [
          [spent, "failed"],
          [fresh, "completed"],
        ],
      );
      assert.deepEqual(yield* Ref.get(boot.startedTurns), [
        spent,
        fresh,
        sentinelSource,
        sentinelTarget,
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
