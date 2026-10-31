import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { VoiceError, type VoiceStartInput } from "@t3tools/contracts";
import * as VoiceSession from "./VoiceSession.ts";
import * as VoiceProvider from "./VoiceProvider.ts";
import * as VoiceTools from "./VoiceTools.ts";

it.effect("binds calls to their owner, deduplicates actions, and refuses tools after End", () =>
  Effect.gen(function* () {
    let count = 0;
    const layer = VoiceSession.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(VoiceProvider.VoiceProvider, {
            status: Effect.succeed({ configured: true }),
            configure: () => Effect.void,
            start: () => Effect.succeed({ sessionId: "live-1", sdp: "answer" }),
            end: () => Effect.void,
          }),
          Layer.succeed(VoiceTools.VoiceTools, {
            execute: () =>
              Effect.sync(() => {
                count++;
                return JSON.stringify({ ok: true });
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const voice = yield* VoiceSession.VoiceSession;
      const owner = {
        sessionId: "owner",
        scopes: ["orchestration:operate", "orchestration:read"],
      } as const;
      const input: VoiceStartInput = { sdp: "offer", mode: "call" };
      const session = yield* voice.start(owner, input);
      yield* voice.start({ ...owner, scopes: [] }, input).pipe(Effect.flip);
      const call = {
        sessionId: session.sessionId,
        callId: "call-1",
        name: "t3_thread_send",
        arguments: { threadId: "thread", message: "hello" },
      };
      const refused = yield* voice
        .execute({ ...owner, sessionId: "other" }, call)
        .pipe(Effect.flip);
      assert.instanceOf(refused, VoiceError);
      assert.strictEqual(count, 0);
      const results = yield* Effect.all([voice.execute(owner, call), voice.execute(owner, call)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(results[0], results[1]);
      assert.strictEqual(count, 1);
      yield* voice
        .execute(owner, { ...call, callId: "blocked", name: "t3_project_delete" })
        .pipe(Effect.flip);
      const guarded = {
        ...call,
        callId: "guarded",
        arguments: { ...call.arguments, mode: "restart" },
      };
      assert.strictEqual((yield* voice.execute(owner, guarded)).status, "confirmation_required");
      assert.strictEqual(count, 1);
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "guarded",
        accepted: false,
      });
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "guarded",
        accepted: true,
      });
      assert.strictEqual(count, 1);
      yield* voice.execute(owner, { ...guarded, callId: "approved" });
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "approved",
        accepted: true,
      });
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "approved",
        accepted: true,
      });
      assert.strictEqual(count, 2);
      yield* voice.end(owner, session.sessionId);
      yield* voice.execute(owner, { ...call, callId: "call-2" }).pipe(Effect.flip);
      assert.strictEqual(count, 2);
      yield* voice.start(owner, { ...input, mode: "dictation" });
      yield* voice.execute(owner, call).pipe(Effect.flip);
      assert.strictEqual(count, 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("ends provider sessions when the connection scope closes", () =>
  Effect.gen(function* () {
    const ended: string[] = [];
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      VoiceSession.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(VoiceProvider.VoiceProvider, {
              status: Effect.succeed({ configured: true }),
              configure: () => Effect.void,
              start: () => Effect.succeed({ sessionId: "live-1", sdp: "answer" }),
              end: (sessionId) =>
                Effect.sync(() => {
                  ended.push(sessionId);
                }),
            }),
            Layer.succeed(VoiceTools.VoiceTools, {
              execute: () => Effect.succeed("{}"),
            }),
          ),
        ),
      ),
      scope,
    );
    const voice = Context.get(context, VoiceSession.VoiceSession);
    const owner = {
      sessionId: "owner",
      scopes: ["orchestration:operate", "orchestration:read"],
    } as const;
    const session = yield* voice.start(owner, { sdp: "offer", mode: "call" });
    assert.deepEqual(ended, []);
    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(ended, [session.sessionId]);
    const refused = yield* voice.end(owner, session.sessionId).pipe(Effect.flip);
    assert.strictEqual(refused.reason, "session_closed");
  }),
);
