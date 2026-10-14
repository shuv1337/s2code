import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type WatchCommandErrorCode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { parseAdmissionRejection } from "./DispatchAdmission.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const threadId = ThreadId.make("thread:watch-admission");
type Dispatch = Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }>;

const makeHarness = Effect.fn("watchAdmissionHarness")(function* (
  name: string,
  options: { native?: boolean; failSteer?: boolean } = {},
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: RunId[] = [];
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let interrupts = 0;
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: options.native ?? true },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              started.push(turn);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${turn.attemptId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          steerTurn: (turn) =>
            Effect.gen(function* () {
              steered.push(turn.runId);
              if (!options.failSteer) return;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId: turn.providerTurnId,
                cause: "completed while delivering",
              });
            }),
          interruptTurn: () =>
            Effect.sync(() => {
              interrupts++;
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
  const setup = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:watch-admission"),
      title: "Watch",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const command = (
      id: string,
      action: "send" | "queue" | "steer",
      targetRunId = RunId.make("stale"),
    ): Dispatch => ({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text: id,
      attachments: [],
      createdBy: "user",
      creationSource: "mobile",
      principal: "watch-session-one",
      dispatchMode:
        action === "send"
          ? { type: "start_immediately" }
          : action === "queue"
            ? { type: "queue_after_active" }
            : { type: "steer_active", targetRunId },
      admission: {
        kind: "watch",
        notAfter: DateTime.add(now, { hours: 1 }),
        steerFollowUpPolicy: "none",
        ...(action === "send"
          ? { action, constraint: { type: "requireIdle" } }
          : action === "queue"
            ? { action, constraint: { type: "requireActive" } }
            : { action, constraint: { type: "requireNativeSteerOf", targetRunId } }),
      },
      steerFollowUpPolicy: "none",
    });
    const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
      orchestrator.streamDomainEvents.pipe(
        Stream.filter(predicate),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
    // The event sink returns the existing receipt without overwriting it. This
    // exercises the real receipt repository shared by the harness's private stores.
    const receipt = (id: string) =>
      sink.commitRejectedCommand({
        commandId: CommandId.make(id),
        threadId,
        commandType: "message.dispatch",
        rejectedAt: now,
        error: "test:missing-receipt",
      });
    const reject = (input: Dispatch, code: WatchCommandErrorCode) =>
      Effect.gen(function* () {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(input))));
        const row = yield* receipt(input.commandId);
        assert.equal(row.status, "rejected");
        assert.equal(row.admissionAction, input.admission?.action);
        assert.deepEqual(parseAdmissionRejection(row.error ?? ""), Option.some(code));
      });
    const start = Effect.gen(function* () {
      const running = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* orchestrator.dispatch(command("first", "send"));
      yield* worker.drain();
      yield* Fiber.join(running);
      return started[0]!;
    });
    const complete = Effect.gen(function* () {
      const first = started[0]!;
      const completed = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === first.runId &&
          event.payload.status === "waiting",
      );
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const turn = projection.providerTurns[0]!;
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
      });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        runOrdinal: first.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(completed);
    });
    return { orchestrator, worker, sink, command, receipt, reject, start, complete, now };
  });
  return { layer, setup, started, steered, entered, release, interrupts: () => interrupts };
});

it.effect("admits idle send, rejects busy send, rejects idle queue and admits busy queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("watch-admission-modes");
      yield* Effect.gen(function* () {
        const s = yield* h.setup;
        yield* s.reject(s.command("idle-queue", "queue"), "thread_idle");
        yield* s.start;
        yield* s.reject(s.command("busy-send", "send"), "thread_busy");
        let projection = yield* s.orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs.length, 1);
        assert.equal(projection.messages.length, 1);
        yield* s.orchestrator.dispatch(s.command("busy-queue", "queue"));
        assert.equal((yield* s.receipt("busy-queue")).admissionAction, "queue");
        yield* s.worker.drain();
        projection = yield* s.orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs.filter((run) => run.status === "queued").length, 1);
        assert.equal(h.started.length, 1);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect.each([true, false])("strict native steer with native capability %s", (native) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness(`watch-steer-${native}`, { native });
      yield* Effect.gen(function* () {
        const s = yield* h.setup;
        const first = yield* s.start;
        yield* s.reject(s.command("stale", "steer"), "stale_target");
        const steer = s.command("steer", "steer", first.runId);
        if (native) {
          yield* s.orchestrator.dispatch(steer);
          assert.equal((yield* s.receipt("steer")).admissionAction, "steer");
        } else yield* s.reject(steer, "steering_unsupported");
        yield* s.worker.drain();
        assert.deepEqual(h.steered, native ? [first.runId] : []);
        assert.equal(h.started.length, 1);
        assert.equal(h.interrupts(), 0);
        assert.equal((yield* s.orchestrator.getThreadProjection(threadId)).runs.length, 1);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("rejects a selection-forced restart and provider mismatch without restarting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("watch-steer-selection");
      yield* Effect.gen(function* () {
        const s = yield* h.setup;
        const first = yield* s.start;
        yield* s.reject(
          {
            ...s.command("selection", "steer", first.runId),
            modelSelection: { instanceId, model: "other-model" },
          },
          "steering_would_restart",
        );
        const input = s.command("provider", "steer", first.runId);
        yield* s.reject(
          {
            ...input,
            admission: {
              ...input.admission!,
              expectedProviderInstanceId: ProviderInstanceId.make("other"),
            },
          },
          "provider_mismatch",
        );
        yield* s.worker.drain();
        assert.equal(h.interrupts(), 0);
        assert.equal(h.started.length, 1);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("rejects the planner's completed-turn fallback for a strict steer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("watch-completed-before-dispatch");
      yield* Effect.gen(function* () {
        const s = yield* h.setup;
        const first = yield* s.start;
        yield* s.complete;
        yield* s.reject(s.command("late-steer", "steer", first.runId), "steering_would_restart");
        yield* s.worker.drain();
        assert.equal(h.started.length, 1);
        assert.equal((yield* s.orchestrator.getThreadProjection(threadId)).runs.length, 1);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect("persists expiry and replays the rejection after expiry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("watch-expiry");
      yield* Effect.gen(function* () {
        const s = yield* h.setup;
        const input = s.command("expired", "send");
        const expired = {
          ...input,
          admission: { ...input.admission!, notAfter: DateTime.subtract(s.now, { seconds: 1 }) },
        };
        yield* s.reject(expired, "expired");
        const before = yield* s.receipt("expired");
        yield* s.reject(expired, "expired");
        assert.deepEqual(yield* s.receipt("expired"), before);
        yield* s.worker.drain();
        assert.equal(h.started.length, 0);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect(
  "concurrent identical commands commit once; changed text or principal conflicts without overwriting",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness("watch-receipt-identity");
        yield* Effect.gen(function* () {
          const s = yield* h.setup;
          const input = s.command("same", "send");
          const results = yield* Effect.all(
            [s.orchestrator.dispatch(input), s.orchestrator.dispatch(input)],
            { concurrency: "unbounded" },
          );
          assert.equal(results[0].sequence, results[1].sequence);
          const before = yield* s.receipt("same");
          assert.equal(before.status, "accepted");
          assert.equal(before.admissionAction, "send");
          assert.match(before.payloadFingerprint!, /^[a-f0-9]{64}$/);
          assert.equal(before.principal, "watch-session-one");
          for (const changed of [
            { ...input, text: "different" },
            { ...input, principal: "watch-session-two" },
            { ...input, admission: undefined, principal: undefined },
            s.command("same", "queue"),
          ]) {
            const error = yield* Effect.flip(s.orchestrator.dispatch(changed));
            assert.deepEqual(
              parseAdmissionRejection(error.message),
              Option.some("command_conflict"),
            );
            assert.deepEqual(yield* s.receipt("same"), before);
          }
          yield* s.worker.drain();
          assert.equal(h.started.length, 1);
          assert.equal((yield* s.orchestrator.getThreadProjection(threadId)).runs.length, 1);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect("legacy null-fingerprint receipts retain replay behavior", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("watch-legacy-receipt");
      yield* Effect.gen(function* () {
        const s = yield* h.setup;
        const input = s.command("legacy", "send");
        const projection = yield* s.orchestrator.getThreadProjection(threadId);
        const result = yield* s.sink.commitCommand({
          commandId: input.commandId,
          threadId,
          commandType: input.type,
          acceptedAt: s.now,
          effects: [],
          events: [
            {
              id: EventId.make("event:legacy"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: s.now,
              payload: projection.thread,
            },
          ],
        });
        assert.isNull(result.receipt.payloadFingerprint);
        assert.isNull(result.receipt.admissionAction);
        const replay = yield* s.orchestrator.dispatch({ ...input, text: "different" });
        assert.equal(replay.sequence, result.receipt.resultSequence);
        yield* s.worker.drain();
        assert.equal(h.started.length, 0);
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);

it.effect.each(["none", "follow_up"] as const)(
  "completion before steer execution obeys %s",
  (policy) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness(`watch-completed-steer-${policy}`);
        yield* Effect.gen(function* () {
          const s = yield* h.setup;
          const first = yield* s.start;
          const {
            admission: _admission,
            steerFollowUpPolicy: _policy,
            ...base
          } = s.command("steer", "steer", first.runId);
          yield* s.orchestrator.dispatch({
            ...base,
            ...(policy === "none" ? { steerFollowUpPolicy: policy } : {}),
          });
          yield* s.complete;
          yield* s.worker.drain();
          assert.equal(h.started.length, policy === "none" ? 1 : 2);
          if (policy === "none") {
            const row = yield* s.receipt("steer");
            assert.equal(row.status, "accepted");
            assert.deepEqual(parseAdmissionRejection(row.error ?? ""), Option.some("stale_target"));
            yield* s.worker.drain();
            assert.equal(h.started.length, 1);
          }
        }).pipe(Effect.provide(h.layer));
      }),
    ),
);

it.effect("completion during strict steer delivery fails durably without follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness("watch-completed-during-steer", { failSteer: true });
      yield* Effect.gen(function* () {
        const s = yield* h.setup;
        const first = yield* s.start;
        yield* s.orchestrator.dispatch(s.command("steer", "steer", first.runId));
        const delivery = yield* s.worker.runOnce.pipe(Effect.forkScoped);
        yield* Deferred.await(h.entered);
        yield* s.complete;
        yield* Deferred.succeed(h.release, undefined);
        yield* Fiber.join(delivery);
        yield* s.worker.drain();
        assert.equal(h.started.length, 1);
        assert.deepEqual(
          parseAdmissionRejection((yield* s.receipt("steer")).error ?? ""),
          Option.some("stale_target"),
        );
      }).pipe(Effect.provide(h.layer));
    }),
  ),
);
