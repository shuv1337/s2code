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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProjectionRecords } from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const FAILOVER_ID_PREFIX = "usage-limit-failover:";

/**
 * Continues a thread whose latest run spent a pooled instance's quota on the healthiest pool
 * member. A run started by a failover never fails over again, so a chain switches at most once.
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
    run.userMessageId.startsWith(FAILOVER_ID_PREFIX) ||
    thread.providerInstanceId !== run.providerInstanceId ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
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
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const failOver = Effect.fn("UsageLimitFailoverWorker.failOver")(function* (
      threadId: ThreadId,
      runId: RunId,
    ) {
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
      if (command?.type !== "message.dispatch") return;
      yield* Effect.logInfo("orchestration-v2.usage-limit-failover", {
        threadId,
        runId,
        from: projection.thread.providerInstanceId,
        to: command.modelSelection?.instanceId,
      });
      yield* threads.dispatch(command);
    });
    // Run finalization commits `run.updated`, so the failure item is already persisted.
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "failed"
          ? failOver(event.payload.threadId, event.payload.id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.usage-limit-failover.failed", {
                  threadId: event.payload.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
    );
  }),
);
