import {
  CommandId,
  ThreadId,
  WatchCommandErrorCode,
  WatchThreadActivity,
  WATCH_MAX_TEXT_BYTES,
  WATCH_MAX_TEXT_CODE_POINTS,
  WATCH_MAX_BODY_BYTES,
  WATCH_MAX_THREAD_PAGE_SIZE,
  isProviderNativeSubagentThread,
  OrchestrationV2ProviderSession,
  type WatchCapabilities,
  type WatchCommandEnvelope,
  type WatchCommandReceipt,
  type WatchThreadPage,
  type WatchThreadSummary,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import { parseAdmissionRejection } from "../orchestration-v2/DispatchAdmission.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { WatchCursor, type WatchRestriction } from "./WatchProjection.ts";

export class WatchServiceError extends Schema.TaggedError<WatchServiceError>()(
  "WatchServiceError",
  {
    code: WatchCommandErrorCode,
  },
) {
  override get message() {
    return `Watch request rejected: ${this.code}.`;
  }
}
export class WatchStorageError extends Schema.TaggedError<WatchStorageError>()(
  "WatchStorageError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Unable to access Watch state.";
  }
}
type Failure = WatchServiceError | WatchStorageError;
type Restricted = { readonly restriction?: WatchRestriction | undefined };
type ReceiptInput = Restricted & { readonly commandId: CommandId; readonly principal: string };

export class WatchService extends Context.Service<
  WatchService,
  {
    readonly capabilities: () => Effect.Effect<WatchCapabilities>;
    readonly listThreads: (
      input: Restricted & { readonly cursor?: string; readonly limit: number },
    ) => Effect.Effect<WatchThreadPage, Failure>;
    readonly getThread: (
      input: Restricted & { readonly threadId: ThreadId },
    ) => Effect.Effect<WatchThreadSummary, Failure>;
    readonly submitCommand: (
      input: Restricted & { readonly envelope: WatchCommandEnvelope; readonly principal: string },
    ) => Effect.Effect<WatchCommandReceipt, Failure>;
    readonly getReceipt: (input: ReceiptInput) => Effect.Effect<WatchCommandReceipt, Failure>;
  }
>()("t3/watch/WatchService") {}

function toDispatchCommand(
  envelope: WatchCommandEnvelope,
  principal: string,
): OrchestrationV2Command {
  const common = {
    kind: "watch" as const,
    notAfter: envelope.notAfter,
    steerFollowUpPolicy: "none" as const,
    ...(envelope.expectedProviderInstanceId === undefined
      ? {}
      : { expectedProviderInstanceId: envelope.expectedProviderInstanceId }),
  };
  return {
    type: "message.dispatch",
    commandId: envelope.commandId,
    threadId: envelope.threadId,
    messageId: envelope.messageId,
    text: envelope.text,
    attachments: [],
    createdBy: "user",
    creationSource: "mobile",
    principal,
    steerFollowUpPolicy: "none",
    dispatchMode:
      envelope.action === "steer"
        ? { type: "steer_active", targetRunId: envelope.targetRunId }
        : { type: envelope.action === "send" ? "start_immediately" : "queue_after_active" },
    admission:
      envelope.action === "steer"
        ? {
            ...common,
            action: "steer",
            constraint: { type: "requireNativeSteerOf", targetRunId: envelope.targetRunId },
          }
        : envelope.action === "send"
          ? { ...common, action: "send", constraint: { type: "requireIdle" } }
          : { ...common, action: "queue", constraint: { type: "requireActive" } },
  };
}

const storageError = (cause: unknown) => new WatchStorageError({ cause });
const isActivity = Schema.is(WatchThreadActivity);
const cursorCodec = Schema.fromJsonString(WatchCursor);
const decodeCursor = Schema.decodeEffect(cursorCodec);
const encodeCursor = Schema.encodeEffect(cursorCodec);
const decodeSession = Schema.decodeEffect(
  Schema.fromJsonString(
    OrchestrationV2ProviderSession.mapFields((fields) => ({
      ...fields,
      createdAt: Schema.DateTimeUtcFromString,
      updatedAt: Schema.DateTimeUtcFromString,
    })),
  ),
);
const activity = (value: string): WatchThreadActivity => (isActivity(value) ? value : "unknown");

function boundedExcerpt(value: string | null | undefined): string | null {
  if (value == null) return null;
  let excerpt = "";
  for (const scalar of value) {
    if (excerpt.length + scalar.length > 280) break;
    excerpt += scalar;
  }
  return excerpt;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const shellFor = Effect.fn("WatchService.shellFor")(function* (
    threadId: ThreadId,
    restriction?: WatchRestriction,
  ) {
    if (restriction?.threadIds !== undefined && !restriction.threadIds.includes(threadId))
      return yield* new WatchServiceError({ code: "forbidden" });
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(storageError));
    if (shell === null) return yield* new WatchServiceError({ code: "thread_not_found" });
    if (restriction?.projectIds !== undefined && !restriction.projectIds.includes(shell.projectId))
      return yield* new WatchServiceError({ code: "forbidden" });
    return shell;
  });

  const getThread: WatchService["Service"]["getThread"] = Effect.fn("WatchService.getThread")(
    function* (input) {
      const shell = yield* shellFor(input.threadId, input.restriction);
      const descriptor = yield* environment.getDescriptor;
      const project = yield* projects.get(shell.projectId).pipe(Effect.mapError(storageError));
      const sessions = yield* sql<{ payload_json: string }>`
      SELECT s.payload_json FROM orchestration_v2_projection_provider_sessions s
      JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id = s.provider_session_id
      WHERE b.thread_id = ${shell.id} AND json_extract(s.payload_json, '$.providerInstanceId') = ${shell.providerInstanceId}
      ORDER BY s.updated_at DESC, s.provider_session_id DESC LIMIT 1
    `.pipe(Effect.mapError(storageError));
      const session =
        sessions[0] === undefined
          ? null
          : yield* decodeSession(sessions[0].payload_json).pipe(Effect.mapError(storageError));
      const extra = yield* sql<{ queued: number; excerpt: string | null }>`
      SELECT (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = ${shell.id} AND status = 'queued') AS queued,
        (SELECT substr(json_extract(payload_json, '$.text'), 1, 280)
          FROM orchestration_v2_projection_messages WHERE thread_id = ${shell.id} AND role = 'assistant'
          ORDER BY updated_at DESC, message_id DESC LIMIT 1) AS excerpt
    `.pipe(Effect.mapError(storageError));
      const revision = yield* events.latestApplicationSequence.pipe(Effect.mapError(storageError));
      const provider =
        session?.driver ?? (yield* providers.getInstance(shell.providerInstanceId))?.driverKind;
      if (provider === undefined)
        return yield* new WatchServiceError({ code: "provider_mismatch" });
      return {
        environmentId: descriptor.environmentId,
        threadId: shell.id,
        projectId: shell.projectId,
        labels: {
          environment: descriptor.label,
          project: Option.getOrNull(project)?.title ?? null,
          thread: shell.title,
        },
        provider,
        providerInstanceId: shell.providerInstanceId,
        activity: activity(shell.activityRunStatus ?? shell.status),
        activeRunId: shell.activeRunId,
        capabilities: {
          supportsActiveSteering: session?.capabilities.turns.supportsActiveSteering ?? false,
          activeSteeringInterruptsTools:
            session?.capabilities.turns.activeSteeringInterruptsTools ?? false,
          supportsQueuedMessages: session?.capabilities.turns.supportsQueuedMessages ?? false,
        },
        queuedCount: extra[0]?.queued ?? 0,
        pendingAttention: {
          runtimeRequest: shell.pendingRuntimeRequest,
          hasActionableProposedPlan: shell.hasActionableProposedPlan,
        },
        latestAssistantExcerpt: boundedExcerpt(extra[0]?.excerpt),
        isReadOnly: isProviderNativeSubagentThread(shell),
        parentThreadId: shell.lineage.parentThreadId,
        snapshotRevision: revision,
        updatedAt: shell.updatedAt,
      };
    },
  );

  const readReceipt = Effect.fn("WatchService.getReceipt")(function* (
    input: ReceiptInput,
    knownAction?: WatchCommandReceipt["action"],
  ): Effect.fn.Return<WatchCommandReceipt, Failure> {
    const found = yield* receipts
      .getByCommandId(input.commandId)
      .pipe(Effect.mapError(storageError));
    if (Option.isNone(found)) return yield* new WatchServiceError({ code: "thread_not_found" });
    const receipt = found.value;
    // TODO(W1): persist watchAction beside principal/fingerprint on both accepted and rejected
    // receipts. Submit knows the action; standalone lookup must fail closed until it is stored.
    if (!("principal" in receipt) || receipt.principal !== input.principal)
      return yield* new WatchServiceError({ code: "forbidden" });
    const shell = yield* shellFor(receipt.threadId, input.restriction);
    const action = "watchAction" in receipt ? receipt.watchAction : knownAction;
    if (action !== "send" && action !== "queue" && action !== "steer")
      return yield* new WatchServiceError({ code: "invalid_envelope" });
    const common = {
      commandId: receipt.commandId,
      threadId: receipt.threadId,
      action: action as WatchCommandReceipt["action"],
      observed: {
        activeRunId: shell.activeRunId,
        activity: activity(shell.activityRunStatus ?? shell.status),
      },
    };
    const code =
      receipt.error === null
        ? "invalid_envelope"
        : Option.getOrElse(
            parseAdmissionRejection(receipt.error),
            () => "invalid_envelope" as const,
          );
    if (receipt.status === "accepted") {
      // A committed strict steer that could not be applied afterwards keeps its accepted receipt
      // but records the failure in `error`; it must not read as success.
      if (receipt.error === null)
        return {
          ...common,
          status: "accepted",
          acceptedAt: receipt.acceptedAt,
          resultSequence: receipt.resultSequence,
          error: null,
        };
      return {
        ...common,
        status: "failed",
        acceptedAt: receipt.acceptedAt,
        resultSequence: receipt.resultSequence,
        error: { code, message: `Watch command could not be applied: ${code}.` },
      };
    }
    return {
      ...common,
      status: "rejected",
      acceptedAt: null,
      resultSequence: null,
      error: { code, message: `Watch command rejected: ${code}.` },
    };
  });

  return WatchService.of({
    capabilities: Effect.fn("WatchService.capabilities")(function* () {
      return {
        protocolVersion: 1,
        environmentId: yield* environment.getEnvironmentId,
        actions: ["send", "queue", "steer"],
        limits: {
          maxTextCodePoints: WATCH_MAX_TEXT_CODE_POINTS,
          maxTextBytes: WATCH_MAX_TEXT_BYTES,
          maxBodyBytes: WATCH_MAX_BODY_BYTES,
          maxThreadPageSize: WATCH_MAX_THREAD_PAGE_SIZE,
        },
        features: {
          idempotentReceipts: true,
          commandExpiry: true,
          threadPagination: true,
          nativeSteerOnly: true,
          steerFollowUp: false,
          threadAllowList: true,
          projectAllowList: true,
        },
      };
    }),
    getThread,
    getReceipt: readReceipt,
    listThreads: Effect.fn("WatchService.listThreads")(function* (input) {
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > WATCH_MAX_THREAD_PAGE_SIZE
      )
        return yield* new WatchServiceError({ code: "invalid_envelope" });
      const cursor =
        input.cursor === undefined
          ? undefined
          : yield* decodeCursor(Buffer.from(input.cursor, "base64url").toString("utf8")).pipe(
              Effect.mapError(() => new WatchServiceError({ code: "invalid_envelope" })),
            );
      const rows = yield* threads
        .listWatchThreadIds({ ...input, cursor, limit: input.limit + 1 })
        .pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(storageError));
      const selected = rows.slice(0, input.limit);
      const items = yield* Effect.forEach(selected, (row) =>
        getThread({ threadId: row.threadId, restriction: input.restriction }),
      );
      const last = selected.at(-1);
      const nextCursor =
        rows.length > input.limit && last !== undefined
          ? Buffer.from(yield* encodeCursor(last).pipe(Effect.mapError(storageError))).toString(
              "base64url",
            )
          : null;
      return {
        items,
        nextCursor,
        snapshotRevision: yield* events.latestApplicationSequence.pipe(
          Effect.mapError(storageError),
        ),
      };
    }),
    submitCommand: Effect.fn("WatchService.submitCommand")(function* (input) {
      const { envelope, principal, restriction } = input;
      if (envelope.environmentId !== (yield* environment.getEnvironmentId))
        return yield* new WatchServiceError({ code: "environment_mismatch" });
      const shell = yield* shellFor(envelope.threadId, restriction);
      if (isProviderNativeSubagentThread(shell))
        return yield* new WatchServiceError({ code: "thread_read_only" });
      if (Buffer.byteLength(envelope.text, "utf8") > WATCH_MAX_TEXT_BYTES)
        return yield* new WatchServiceError({ code: "text_too_long" });
      const result = yield* threads.dispatch(toDispatchCommand(envelope, principal)).pipe(
        Effect.as(null),
        Effect.catchTags({
          DispatchAdmissionRejectedError: (error) => Effect.succeed(error.code),
          OrchestratorCommandIdConflictError: () => Effect.succeed("command_conflict" as const),
          OrchestratorCommandPreviouslyRejectedError: () => Effect.succeed(null),
        }),
        Effect.mapError(storageError),
      );
      if (result !== null) {
        const observed = yield* shellFor(envelope.threadId, restriction);
        return {
          commandId: envelope.commandId,
          threadId: envelope.threadId,
          action: envelope.action,
          status: "rejected",
          acceptedAt: null,
          resultSequence: null,
          error: { code: result, message: `Watch command rejected: ${result}.` },
          observed: {
            activeRunId: observed.activeRunId,
            activity: activity(observed.activityRunStatus ?? observed.status),
          },
        };
      }
      return yield* readReceipt(
        { commandId: envelope.commandId, principal, restriction },
        envelope.action,
      );
    }),
  });
});

export const layer = Layer.effect(WatchService, make);
