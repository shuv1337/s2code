import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { WatchAction } from "./watchAdmission.ts";

export { WatchAction, WatchAdmission, OrchestrationDispatchAdmission } from "./watchAdmission.ts";

export const WatchProtocolVersion = Schema.Literal(1);
export type WatchProtocolVersion = typeof WatchProtocolVersion.Type;

export const WATCH_MAX_TEXT_CODE_POINTS = 8_000;
export const WATCH_MAX_TEXT_BYTES = 32 * 1_024;
export const WATCH_MAX_BODY_BYTES = 48 * 1_024;
export const WATCH_MAX_THREAD_PAGE_SIZE = 50;
export const WATCH_DEFAULT_THREAD_PAGE_SIZE = 20;

/** Count Unicode scalars, not UTF-16 units; reject unpaired surrogates. */
export const WatchText = Schema.String.check(
  Schema.makeFilter(
    (text) => {
      let count = 0;
      for (const scalar of text) {
        const code = scalar.codePointAt(0)!;
        if ((code >= 0xd800 && code <= 0xdfff) || ++count > WATCH_MAX_TEXT_CODE_POINTS)
          return false;
      }
      return true;
    },
    { expected: "at most 8000 Unicode scalars", toJsonSchema: () => [{ maxLength: 8000 }, true] },
  ),
);
export type WatchText = typeof WatchText.Type;

const envelopeFields = {
  protocolVersion: WatchProtocolVersion,
  commandId: CommandId.check(Schema.isUUID()),
  messageId: MessageId.check(Schema.isUUID()),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  expectedProviderInstanceId: Schema.optionalKey(ProviderInstanceId),
  // The server must also enforce 32 KiB of UTF-8 text and a 48 KiB request body.
  text: WatchText,
  notAfter: Schema.DateTimeUtcFromString,
};

export const WatchCommandEnvelope = Schema.Union([
  Schema.Struct({
    ...envelopeFields,
    action: Schema.Literals(["send", "queue"]),
    targetRunId: Schema.optionalKey(RunId),
  }),
  Schema.Struct({ ...envelopeFields, action: Schema.Literal("steer"), targetRunId: RunId }),
]);
export type WatchCommandEnvelope = typeof WatchCommandEnvelope.Type;

/**
 * Preserve shell/run statuses verbatim (idle plus every OrchestrationV2RunStatus).
 * Prefer activityRunStatus while an activity-owning run exists. Unmapped states
 * become unknown, never idle; activeRunId, not activity, determines admission.
 */
export const WatchThreadActivity = Schema.Literals([
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
  "unknown",
]);
export type WatchThreadActivity = typeof WatchThreadActivity.Type;

export const WatchThreadCapabilities = Schema.Struct({
  supportsActiveSteering: Schema.Boolean,
  activeSteeringInterruptsTools: Schema.Boolean,
  supportsQueuedMessages: Schema.Boolean,
});
export type WatchThreadCapabilities = typeof WatchThreadCapabilities.Type;

export const WatchPendingAttention = Schema.Struct({
  runtimeRequest: OrchestrationV2ThreadShell.fields.pendingRuntimeRequest,
  hasActionableProposedPlan: OrchestrationV2ThreadShell.fields.hasActionableProposedPlan,
});
export type WatchPendingAttention = typeof WatchPendingAttention.Type;

export const WatchThreadSummary = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: OrchestrationV2ThreadShell.fields.id,
  projectId: Schema.NullOr(OrchestrationV2ThreadShell.fields.projectId),
  labels: Schema.Struct({
    environment: Schema.String,
    project: Schema.NullOr(Schema.String),
    thread: OrchestrationV2ThreadShell.fields.title,
  }),
  provider: ProviderDriverKind,
  providerInstanceId: OrchestrationV2ThreadShell.fields.providerInstanceId,
  activity: WatchThreadActivity,
  activeRunId: OrchestrationV2ThreadShell.fields.activeRunId,
  capabilities: WatchThreadCapabilities,
  queuedCount: NonNegativeInt,
  pendingAttention: WatchPendingAttention,
  latestAssistantExcerpt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(280))),
  isReadOnly: Schema.Boolean,
  parentThreadId: OrchestrationV2ThreadShell.fields.lineage.fields.parentThreadId,
  snapshotRevision: NonNegativeInt,
  updatedAt: OrchestrationV2ThreadShell.fields.updatedAt,
});
export type WatchThreadSummary = typeof WatchThreadSummary.Type;

export const WatchThreadPage = Schema.Struct({
  items: Schema.Array(WatchThreadSummary).check(Schema.isMaxLength(WATCH_MAX_THREAD_PAGE_SIZE)),
  nextCursor: Schema.NullOr(Schema.String),
  snapshotRevision: NonNegativeInt,
});
export type WatchThreadPage = typeof WatchThreadPage.Type;

export const WatchCapabilities = Schema.Struct({
  protocolVersion: WatchProtocolVersion,
  environmentId: EnvironmentId,
  actions: Schema.Array(WatchAction),
  limits: Schema.Struct({
    maxTextCodePoints: Schema.Literal(WATCH_MAX_TEXT_CODE_POINTS),
    maxTextBytes: Schema.Literal(WATCH_MAX_TEXT_BYTES),
    maxBodyBytes: Schema.Literal(WATCH_MAX_BODY_BYTES),
    maxThreadPageSize: Schema.Literal(WATCH_MAX_THREAD_PAGE_SIZE),
  }),
  features: Schema.Struct({
    idempotentReceipts: Schema.Literal(true),
    commandExpiry: Schema.Literal(true),
    threadPagination: Schema.Literal(true),
    nativeSteerOnly: Schema.Literal(true),
    steerFollowUp: Schema.Literal(false),
    threadAllowList: Schema.Literal(true),
    projectAllowList: Schema.Literal(true),
  }),
});
export type WatchCapabilities = typeof WatchCapabilities.Type;

export const WatchCommandErrorCode = Schema.Literals([
  "thread_busy",
  "thread_idle",
  "stale_target",
  "steering_unsupported",
  "steering_would_restart",
  "expired",
  "command_conflict",
  "thread_not_found",
  "thread_read_only",
  "forbidden",
  "environment_mismatch",
  "provider_mismatch",
  "invalid_envelope",
  "text_too_long",
]);
export type WatchCommandErrorCode = typeof WatchCommandErrorCode.Type;

export const WatchCommandError = Schema.Struct({
  code: WatchCommandErrorCode,
  message: Schema.String,
});
export type WatchCommandError = typeof WatchCommandError.Type;

export const WatchCommandObservedState = Schema.Struct({
  activeRunId: Schema.NullOr(RunId),
  activity: WatchThreadActivity,
});
export type WatchCommandObservedState = typeof WatchCommandObservedState.Type;

const receiptFields = {
  commandId: CommandId,
  threadId: ThreadId,
  action: WatchAction,
  observed: Schema.NullOr(WatchCommandObservedState),
};

/** Rejections have no acceptance timestamp or committed result sequence. */
export const WatchCommandReceipt = Schema.Union([
  Schema.Struct({
    ...receiptFields,
    status: Schema.Literal("accepted"),
    acceptedAt: Schema.DateTimeUtcFromString,
    resultSequence: NonNegativeInt,
    error: Schema.Null,
  }),
  Schema.Struct({
    ...receiptFields,
    status: Schema.Literal("rejected"),
    acceptedAt: Schema.Null,
    resultSequence: Schema.Null,
    error: WatchCommandError,
  }),
]);
export type WatchCommandReceipt = typeof WatchCommandReceipt.Type;
