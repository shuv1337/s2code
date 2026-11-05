import {
  VoiceError,
  type VoiceReportInput,
  type VoiceStartInput,
  type VoiceStartResult,
  type VoiceToolInput,
  type VoiceToolResult,
} from "@t3tools/contracts";
import {
  isAllowedVoiceTool,
  isConfirmVoiceTool,
  needsSpokenConfirmation,
} from "@t3tools/shared/voice/allowlist";
import { decideConfirmation } from "@t3tools/shared/voice/confirmation";
import { summarizeVoiceArgs } from "@t3tools/shared/voice/logRedaction";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as VoiceAuditLog from "./VoiceAuditLog.ts";
import { voiceModel } from "./VoiceProvider.ts";
import * as VoiceProvider from "./VoiceProvider.ts";
import * as VoiceTools from "./VoiceTools.ts";
import type { VoiceCaller } from "./VoiceTools.ts";

export class VoiceSession extends Context.Service<
  VoiceSession,
  {
    readonly status: VoiceProvider.VoiceProvider["Service"]["status"];
    readonly configure: VoiceProvider.VoiceProvider["Service"]["configure"];
    readonly start: (
      caller: VoiceCaller,
      input: VoiceStartInput,
    ) => Effect.Effect<VoiceStartResult, VoiceError>;
    readonly end: (caller: VoiceCaller, sessionId: string) => Effect.Effect<void, VoiceError>;
    readonly execute: (
      caller: VoiceCaller,
      input: VoiceToolInput,
    ) => Effect.Effect<VoiceToolResult, VoiceError>;
    readonly confirm: (
      caller: VoiceCaller,
      input: { sessionId: string; callId: string; accepted: boolean },
    ) => Effect.Effect<VoiceToolResult, VoiceError>;
    readonly report: (
      caller: VoiceCaller,
      input: VoiceReportInput,
    ) => Effect.Effect<void, VoiceError>;
  }
>()("t3/voice/VoiceSession") {}
interface Session {
  owner: string;
  mode: VoiceStartInput["mode"];
  model: string;
  startedAt: number;
  calls: Map<string, Deferred.Deferred<VoiceToolResult, VoiceError>>;
  pending: Map<string, VoiceToolInput>;
}
const make = Effect.gen(function* () {
  const provider = yield* VoiceProvider.VoiceProvider;
  const tools = yield* VoiceTools.VoiceTools;
  const audit = yield* VoiceAuditLog.VoiceAuditLog;
  const sessions = new Map<string, Session>();
  const owners = new Map<string, string>();
  const elapsed = (startedAt: number) =>
    Effect.map(DateTime.now, (now) => Math.max(0, DateTime.toEpochMillis(now) - startedAt));
  const closeSession = Effect.fn("VoiceSession.close")(function* (
    session: Session,
    id: string,
    endReason: string,
  ) {
    yield* audit.append(id, {
      type: "session.end",
      mode: session.mode,
      model: session.model,
      durationMs: yield* elapsed(session.startedAt),
      endReason,
    });
  });
  yield* Effect.addFinalizer(() => {
    const open = [...sessions.entries()];
    sessions.clear();
    return Effect.forEach(
      open,
      ([id, session]) =>
        closeSession(session, id, "scope_closed").pipe(Effect.andThen(provider.end(id))),
      { discard: true },
    ).pipe(Effect.ignore);
  });
  const owned = Effect.fn("VoiceSession.owned")(function* (caller: VoiceCaller, id: string) {
    const session = sessions.get(id);
    if (!session) return yield* new VoiceError({ reason: "session_closed" });
    if (session.owner !== caller.sessionId) return yield* new VoiceError({ reason: "forbidden" });
    return session;
  });
  const toolCall = Effect.fn("VoiceSession.toolCall")(function* (
    session: Session,
    input: VoiceToolInput,
    status: "completed" | "confirmation_required" | "cancelled" | "error",
    startedAt: number,
    resultChars: number,
  ) {
    yield* audit.append(input.sessionId, {
      type: "tool.call",
      mode: session.mode,
      callId: input.callId,
      name: input.name,
      argsSummary: summarizeVoiceArgs(input.arguments),
      status,
      durationMs: yield* elapsed(startedAt),
      resultChars,
    });
  });
  const start = Effect.fn("VoiceSession.start")(function* (
    caller: VoiceCaller,
    input: VoiceStartInput,
  ) {
    if (!caller.scopes.includes("orchestration:operate"))
      return yield* new VoiceError({ reason: "forbidden" });
    yield* audit.retain();
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const result = yield* provider.start(input);
    const model = voiceModel(input.mode);
    sessions.set(result.sessionId, {
      owner: caller.sessionId,
      mode: input.mode,
      model,
      startedAt,
      calls: new Map(),
      pending: new Map(),
    });
    owners.set(result.sessionId, caller.sessionId);
    yield* audit.append(result.sessionId, { type: "session.start", mode: input.mode, model });
    return result;
  });
  const end = Effect.fn("VoiceSession.end")(function* (caller: VoiceCaller, id: string) {
    const session = yield* owned(caller, id);
    sessions.delete(id);
    yield* closeSession(session, id, "client");
    yield* provider.end(id);
  });
  const run = Effect.fn("VoiceSession.run")(function* (
    caller: VoiceCaller,
    session: Session,
    input: VoiceToolInput,
  ) {
    const previous = session.calls.get(input.callId);
    if (previous) return yield* Deferred.await(previous);
    const result = Deferred.makeUnsafe<VoiceToolResult, VoiceError>();
    session.calls.set(input.callId, result);
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const exit = yield* tools
      .execute(caller, input.name, input.arguments, `${input.sessionId}:${input.callId}`)
      .pipe(
        Effect.map((output): VoiceToolResult => ({ status: "completed", output })),
        Effect.exit,
      );
    yield* Deferred.done(result, exit);
    if (Exit.isFailure(exit)) {
      yield* toolCall(session, input, "error", startedAt, 0);
      return yield* Effect.failCause(exit.cause);
    }
    yield* toolCall(session, input, "completed", startedAt, exit.value.output.length);
    return exit.value;
  });
  const execute = Effect.fn("VoiceSession.execute")(function* (
    caller: VoiceCaller,
    input: VoiceToolInput,
  ) {
    const session = yield* owned(caller, input.sessionId);
    if (
      session.mode !== "call" ||
      (!isAllowedVoiceTool(input.name) && !isConfirmVoiceTool(input.name))
    ) {
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      yield* audit.append(input.sessionId, {
        type: "error",
        mode: session.mode,
        where: "session.execute",
        reason: "invalid_call",
        message: "tool is not available in voice",
      });
      yield* toolCall(session, input, "error", startedAt, 0);
      return yield* new VoiceError({ reason: "invalid_call" });
    }
    const previous = session.calls.get(input.callId);
    if (previous) return yield* Deferred.await(previous);
    if (needsSpokenConfirmation(input.name, input.arguments)) {
      const saved = session.pending.get(input.callId) ?? input;
      session.pending.set(input.callId, saved);
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const decision = decideConfirmation({
        tool: saved.name,
        args: saved.arguments,
        environmentLabel: null,
      });
      const output = decision.action === "await_confirm" ? decision.speak : "Confirm this action.";
      yield* toolCall(session, saved, "confirmation_required", startedAt, output.length);
      return { status: "confirmation_required", output } satisfies VoiceToolResult;
    }
    return yield* run(caller, session, input);
  });
  const confirm = Effect.fn("VoiceSession.confirm")(function* (
    caller: VoiceCaller,
    input: { sessionId: string; callId: string; accepted: boolean },
  ) {
    const session = yield* owned(caller, input.sessionId);
    yield* audit.append(input.sessionId, {
      type: "confirm",
      mode: session.mode,
      callId: input.callId,
      accepted: input.accepted,
    });
    const previous = session.calls.get(input.callId);
    if (previous) return yield* Deferred.await(previous);
    const pending = session.pending.get(input.callId);
    if (!pending) {
      yield* audit.append(input.sessionId, {
        type: "error",
        mode: session.mode,
        where: "session.confirm",
        reason: "invalid_call",
        message: "no confirmation is pending",
      });
      return yield* new VoiceError({ reason: "invalid_call" });
    }
    session.pending.delete(input.callId);
    if (!input.accepted) {
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const result: VoiceToolResult = { status: "completed", output: '{"cancelled":true}' };
      const done = Deferred.makeUnsafe<VoiceToolResult, VoiceError>();
      yield* Deferred.succeed(done, result);
      session.calls.set(input.callId, done);
      yield* toolCall(session, pending, "cancelled", startedAt, result.output.length);
      return result;
    }
    return yield* run(caller, session, pending);
  });
  const report = Effect.fn("VoiceSession.report")(function* (
    caller: VoiceCaller,
    input: VoiceReportInput,
  ) {
    if (!caller.scopes.includes("orchestration:operate"))
      return yield* new VoiceError({ reason: "forbidden" });
    const owner = owners.get(input.sessionId);
    if (owner === undefined) return yield* new VoiceError({ reason: "session_closed" });
    if (owner !== caller.sessionId) return yield* new VoiceError({ reason: "forbidden" });
    const mode = sessions.get(input.sessionId)?.mode ?? input.mode;
    for (const event of input.events) {
      yield* audit.append(input.sessionId, VoiceAuditLog.auditEventFromReport(mode, event));
    }
  });
  return VoiceSession.of({
    status: provider.status,
    configure: provider.configure,
    start,
    end,
    execute,
    confirm,
    report,
  });
});
export const layer = Layer.effect(VoiceSession, make);
