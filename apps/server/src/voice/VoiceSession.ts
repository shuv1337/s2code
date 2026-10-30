import {
  VoiceError,
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
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  }
>()("t3/voice/VoiceSession") {}
interface Session {
  owner: string;
  mode: VoiceStartInput["mode"];
  calls: Map<string, Deferred.Deferred<VoiceToolResult, VoiceError>>;
  pending: Map<string, VoiceToolInput>;
}
const make = Effect.gen(function* () {
  const provider = yield* VoiceProvider.VoiceProvider;
  const tools = yield* VoiceTools.VoiceTools;
  const sessions = new Map<string, Session>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(sessions.keys(), (id) => provider.end(id), { discard: true }).pipe(
      Effect.ignore,
    ),
  );
  const owned = Effect.fn("VoiceSession.owned")(function* (caller: VoiceCaller, id: string) {
    const session = sessions.get(id);
    if (!session) return yield* new VoiceError({ reason: "session_closed" });
    if (session.owner !== caller.sessionId) return yield* new VoiceError({ reason: "forbidden" });
    return session;
  });
  const start = Effect.fn("VoiceSession.start")(function* (
    caller: VoiceCaller,
    input: VoiceStartInput,
  ) {
    if (!caller.scopes.includes("orchestration:operate"))
      return yield* new VoiceError({ reason: "forbidden" });
    const result = yield* provider.start(input);
    sessions.set(result.sessionId, {
      owner: caller.sessionId,
      mode: input.mode,
      calls: new Map(),
      pending: new Map(),
    });
    return result;
  });
  const end = Effect.fn("VoiceSession.end")(function* (caller: VoiceCaller, id: string) {
    yield* owned(caller, id);
    sessions.delete(id);
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
    const exit = yield* tools
      .execute(caller, input.name, input.arguments, `${input.sessionId}:${input.callId}`)
      .pipe(
        Effect.map((output): VoiceToolResult => ({ status: "completed", output })),
        Effect.exit,
      );
    yield* Deferred.done(result, exit);
    return yield* Deferred.await(result);
  });
  const execute = Effect.fn("VoiceSession.execute")(function* (
    caller: VoiceCaller,
    input: VoiceToolInput,
  ) {
    const session = yield* owned(caller, input.sessionId);
    if (
      session.mode !== "call" ||
      (!isAllowedVoiceTool(input.name) && !isConfirmVoiceTool(input.name))
    )
      return yield* new VoiceError({ reason: "invalid_call" });
    const previous = session.calls.get(input.callId);
    if (previous) return yield* Deferred.await(previous);
    if (needsSpokenConfirmation(input.name, input.arguments)) {
      const saved = session.pending.get(input.callId) ?? input;
      session.pending.set(input.callId, saved);
      const decision = decideConfirmation({
        tool: saved.name,
        args: saved.arguments,
        environmentLabel: null,
      });
      return {
        status: "confirmation_required",
        output: decision.action === "await_confirm" ? decision.speak : "Confirm this action.",
      } satisfies VoiceToolResult;
    }
    return yield* run(caller, session, input);
  });
  const confirm = Effect.fn("VoiceSession.confirm")(function* (
    caller: VoiceCaller,
    input: { sessionId: string; callId: string; accepted: boolean },
  ) {
    const session = yield* owned(caller, input.sessionId);
    const previous = session.calls.get(input.callId);
    if (previous) return yield* Deferred.await(previous);
    const pending = session.pending.get(input.callId);
    if (!pending) return yield* new VoiceError({ reason: "invalid_call" });
    session.pending.delete(input.callId);
    if (!input.accepted) {
      const result: VoiceToolResult = { status: "completed", output: '{"cancelled":true}' };
      const done = Deferred.makeUnsafe<VoiceToolResult, VoiceError>();
      yield* Deferred.succeed(done, result);
      session.calls.set(input.callId, done);
      return result;
    }
    return yield* run(caller, session, pending);
  });
  return VoiceSession.of({
    status: provider.status,
    configure: provider.configure,
    start,
    end,
    execute,
    confirm,
  });
});
export const layer = Layer.effect(VoiceSession, make);
