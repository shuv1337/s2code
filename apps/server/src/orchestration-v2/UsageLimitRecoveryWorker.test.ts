import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("skips arming and resuming threads on usage-limit-disabled instances", () =>
  Effect.gen(function* () {
    const now = DateTime.makeUnsafe("2026-11-02T01:00:00.000Z");
    yield* TestClock.setTime(DateTime.toEpochMillis(now));
    const resetAt = "2026-11-02T00:30:00.000Z";
    const instanceId = ProviderInstanceId.make("codex");
    const runId = RunId.make("limited-run");
    const candidate = {
      id: ThreadId.make("limited-thread"),
      providerInstanceId: instanceId,
      status: "failed",
      lastErrorClass: "usage_limit",
      latestRunId: runId,
      usageLimitResetAt: resetAt,
      archivedAt: null,
      settledOverride: null,
      pendingRuntimeRequest: null,
      latestRunCompletedAt: DateTime.makeUnsafe("2026-11-02T00:00:00.000Z"),
      updatedAt: now,
      limitRecovery: null,
      snoozedUntil: null,
    } as const;
    for (const disabled of [true, false]) {
      const actions: Array<string> = [];
      yield* Effect.void.pipe(
        Effect.provide(
          UsageLimitRecoveryWorker.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Scheduler.Scheduler, {
                  register: (_name, sweep) => sweep.pipe(Effect.orDie),
                }),
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getLimitRecoveryCandidates: () =>
                    Effect.succeed([
                      candidate,
                      {
                        ...candidate,
                        id: ThreadId.make("armed-thread"),
                        limitRecovery: { runId, resetAt, autoResume: true },
                      },
                    ]),
                  getLimitRecoveryWakeAt: () => Effect.succeed(null),
                }),
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  dispatch: () =>
                    Effect.sync(() => {
                      actions.push("resume");
                      return {} as never;
                    }),
                }),
                Layer.mock(Orchestrator.OrchestratorV2)({
                  streamDomainEvents: Stream.never,
                  autoArmLimitRecovery: () =>
                    Effect.sync(() => {
                      actions.push("arm");
                      return {} as never;
                    }),
                }),
                ServerSettings.layerTest({
                  autoResumeLimitedThreads: true,
                  providerInstances: {
                    [instanceId]: {
                      driver: ProviderDriverKind.make("codex"),
                      enabled: !disabled,
                      ...(disabled
                        ? {
                            usageLimitDisabled: {
                              at: DateTime.formatIso(now),
                              message: "Quota exhausted",
                            },
                          }
                        : {}),
                    },
                  },
                }),
              ),
            ),
          ),
        ),
      );
      assert.deepEqual(actions, disabled ? [] : ["arm", "resume"]);
    }
  }),
);
