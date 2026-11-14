import {
  CommandId,
  OrchestratorMcpFailure,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type ThreadMetadataMcpAction,
  type ThreadMetadataMcpUpdateInput,
  type ThreadMetadataMcpUpdateResult,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { dispatchFailure, threadNotFound } from "./threadAccess.ts";

export class ThreadMetadataMcpService extends Context.Service<
  ThreadMetadataMcpService,
  {
    readonly configure: (input: {
      readonly threadId: ThreadId;
      readonly modelSelection?: ModelSelection | undefined;
      readonly autoSettle?: false | null | undefined;
    }) => Effect.Effect<{ readonly sequence: number }, OrchestratorMcpFailure>;
    readonly update: (
      scope: McpInvocationScope,
      input: ThreadMetadataMcpUpdateInput,
    ) => Effect.Effect<ThreadMetadataMcpUpdateResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadMetadataMcpService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function commandId(input: {
  readonly scope: McpInvocationScope;
  readonly threadId: ThreadId;
  readonly action: ThreadMetadataMcpAction;
  readonly requestKey: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      "thread-update",
      stablePart(input.threadId),
      stablePart(input.action),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function metadataCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly update: ThreadMetadataMcpUpdateInput;
}): Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }> {
  switch (input.update.action) {
    case "rename":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        title: input.update.title!,
      };
    case "regenerate_title":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        regenerateTitle: true,
      };
  }
}

function resultFromThread(input: {
  readonly action: ThreadMetadataMcpAction;
  readonly commandId: CommandId;
  readonly sequence: number;
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "id" | "title" | "titleRegeneration" | "linkedPullRequest" | "updatedAt"
  >;
}): ThreadMetadataMcpUpdateResult {
  return {
    threadId: input.thread.id,
    action: input.action,
    commandId: input.commandId,
    sequence: input.sequence,
    title: input.thread.title,
    titleRegeneration:
      input.thread.titleRegeneration === undefined || input.thread.titleRegeneration === null
        ? null
        : {
            requestId: input.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(input.thread.titleRegeneration.startedAt),
          },
    linkedPullRequest: input.thread.linkedPullRequest ?? null,
    updatedAt: DateTime.formatIso(input.thread.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const update = Effect.fn("ThreadMetadataMcpService.update")(function* (
    scope: McpInvocationScope,
    input: ThreadMetadataMcpUpdateInput,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant orchestration capabilities.",
      );
    }

    const threadId = input.threadId ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* failure(
        "target_required",
        "Pass threadId: this MCP client is not running inside a T3 thread.",
      );
    }
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to locate thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
    }
    const requestKey =
      input.clientRequestId === undefined ? yield* random.uuidV4() : input.clientRequestId;
    const updateCommandId = commandId({
      scope,
      threadId,
      action: input.action,
      requestKey,
    });
    const dispatched = yield* threadManagement
      .dispatch(
        metadataCommand({
          commandId: updateCommandId,
          threadId,
          update: input,
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to ${input.action} for thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    const metadataEvent = dispatched.storedEvents.find(
      (stored) => stored.event.type === "thread.metadata-updated",
    );
    // Retries may find stored events compacted away; answer from the projection.
    const thread =
      metadataEvent?.event.type === "thread.metadata-updated"
        ? metadataEvent.event.payload
        : yield* threadManagement
            .getThreadShell(threadId)
            .pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
    if (thread === null) {
      return yield* failure(
        "orchestration_error",
        `Thread ${threadId} metadata update completed without a resultant state.`,
      );
    }
    return resultFromThread({
      action: input.action,
      commandId: updateCommandId,
      sequence: dispatched.sequence,
      thread,
    });
  });

  const configure = Effect.fn("ThreadMetadataMcpService.configure")(function* (
    input: Parameters<ThreadMetadataMcpService["Service"]["configure"]>[0],
  ) {
    const thread = yield* threadManagement
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(dispatchFailure));
    if (thread === null || thread.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, input.threadId, "Thread was not found.");
    }
    if (input.autoSettle !== undefined && thread.archivedAt !== null) {
      return yield* failure(
        "invalid_request",
        "Cannot configure auto-settle on an archived thread. Unarchive it first.",
      );
    }
    let result: { readonly sequence: number } | undefined;
    if (input.modelSelection !== undefined) {
      result = yield* threadManagement
        .dispatch({
          type: modelSelectionCommandType(thread.providerInstanceId, input.modelSelection),
          threadId: input.threadId,
          commandId: CommandId.make(yield* random.uuidV4()),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
    }
    if (input.autoSettle !== undefined) {
      result = yield* threadManagement
        .dispatch({
          type: "thread.auto-settle.set",
          threadId: input.threadId,
          commandId: CommandId.make(yield* random.uuidV4()),
          enabled: input.autoSettle !== false,
        })
        .pipe(Effect.mapError(dispatchFailure));
    }
    if (result === undefined) {
      return yield* failure("invalid_request", "Pass modelSelection or autoSettle to configure.");
    }
    return { sequence: result.sequence };
  });

  return ThreadMetadataMcpService.of({ update, configure });
});

export const layer: Layer.Layer<
  ThreadMetadataMcpService,
  never,
  SecureRandom.SecureRandom | ThreadManagementService.ThreadManagementService
> = Layer.effect(ThreadMetadataMcpService, make);
