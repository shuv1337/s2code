import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type RunId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { pickUsageLimitReplacement } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProjectionRecords } from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const FAILOVER_ID_PREFIX = "usage-limit-failover:";
const RETRY_SWEEP_DELAY = Duration.seconds(30);

/**
 * Continues a thread whose latest run spent a pooled instance's quota on the healthiest pool
 * member. A run in a failover chain never fails over again, so a chain switches at most once.
 */
export function usageLimitFailoverCommand(input: {
  readonly projection: ProjectionRecords<"runs" | "turnItems" | "runtimeRequests">;
  readonly runId: RunId;
  readonly providers: readonly ServerProvider[];
  readonly settings: ServerSettingsValue;
  readonly now: number;
}): OrchestrationV2Command | null {
  const { thread, runs, turnItems, runtimeRequests } = input.projection;
  const run = latestExecutedRun(runs);
  if (
    run?.id !== input.runId ||
    run.status !== "failed" ||
    run.delegatedTaskId !== undefined ||
    run.failoverChainId !== undefined ||
    thread.providerInstanceId !== run.providerInstanceId ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > input.now) ||
    runtimeRequests.some((request) => request.status === "pending")
  ) {
    return null;
  }
  const failure = latestRootProviderFailure(run, turnItems);
  if (failure?.class !== "usage_limit" || failure.retryable !== false) return null;
  const modelSelection = pickUsageLimitReplacement({
    selection: run.modelSelection,
    providers: input.providers,
    settings: input.settings,
    projectId: thread.projectId,
    now: input.now,
  });
  if (modelSelection === null) return null;
  const id = `${FAILOVER_ID_PREFIX}${run.id}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId: thread.id,
    manualContinuationOfRunId: run.id,
    failoverChainId: run.id,
    modelSelection,
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const failOver = Effect.fn("UsageLimitFailoverWorker.failOver")(function* (
      threadId: ThreadId,
      runId: RunId,
    ) {
      const commandId = CommandId.make(`${FAILOVER_ID_PREFIX}${runId}`);
      if (Option.isSome(yield* receipts.getByCommandId(commandId))) return;
      const projection = yield* orchestrator.getThreadRecords(
        threadId,
        ["runs", "turnItems", "runtimeRequests"],
        { turnItemTypes: ["error"], turnItemRunIds: [runId] },
      );
      const command = usageLimitFailoverCommand({
        projection,
        runId,
        providers: yield* registry.getProviders,
        settings: yield* settings.getSettings,
        now: yield* Clock.currentTimeMillis,
      });
      if (command?.type !== "message.dispatch") {
        yield* eventSink.commitRejectedCommand({
          commandId,
          threadId,
          commandType: "message.dispatch",
          rejectedAt: yield* DateTime.now,
          error: "Automatic usage-limit failover declined.",
        });
        return;
      }
      yield* Effect.logInfo("orchestration-v2.usage-limit-failover", {
        threadId,
        runId,
        from: projection.thread.providerInstanceId,
        to: command.modelSelection?.instanceId,
      });
      yield* threads.dispatch(command);
    });
    const logFailure = (threadId: ThreadId) => (cause: unknown) =>
      Effect.logWarning("orchestration-v2.usage-limit-failover.failed", { threadId, cause });
    // Receipts preserve both dispatched and declined decisions across sweeps and restarts.
    const sweep = Effect.fn("UsageLimitFailoverWorker.sweep")(function* () {
      const { threads: shells } = yield* orchestrator.getShellSnapshot();
      for (const shell of shells) {
        if (
          shell.status !== "failed" ||
          shell.lastErrorClass !== "usage_limit" ||
          shell.latestRunId === null
        ) {
          continue;
        }
        yield* failOver(shell.id, shell.latestRunId).pipe(Effect.catchCause(logFailure(shell.id)));
      }
    });
    const scope = yield* Scope.Scope;
    const sweepSafely = sweep().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.usage-limit-failover.sweep-failed", { cause }),
      ),
    );
    const retryLater = sweepSafely.pipe(Effect.delay(RETRY_SWEEP_DELAY), Effect.forkIn(scope));
    // Run finalization commits `run.updated`, so the failure item is already persisted.
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "failed"
          ? failOver(event.payload.threadId, event.payload.id).pipe(
              Effect.catchCause((cause) =>
                logFailure(event.payload.threadId)(cause).pipe(Effect.andThen(retryLater)),
              ),
            )
          : Effect.void,
      ),
    );
    // Failures that landed while the server was down, or before the subscription, fail over now.
    yield* forkParked(sweepSafely);
  }),
).pipe(Layer.provide(CommandReceiptStore.layer));
