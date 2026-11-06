import { VoiceError, type VoiceStartInput, type VoiceStartResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { voiceErrorFacts } from "@t3tools/shared/voice/logRedaction";
import { buildLiveFunctionTools, LIVE_SYSTEM_INSTRUCTIONS } from "@t3tools/shared/voice/liveTools";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as VoiceAuditLog from "./VoiceAuditLog.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import WebSocket from "ws";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export class VoiceProvider extends Context.Service<
  VoiceProvider,
  {
    readonly status: Effect.Effect<{ configured: boolean }, VoiceError>;
    readonly configure: (apiKey: string) => Effect.Effect<void, VoiceError>;
    readonly start: (input: VoiceStartInput) => Effect.Effect<VoiceStartResult, VoiceError>;
    readonly end: (sessionId: string) => Effect.Effect<void, VoiceError>;
  }
>()("t3/voice/VoiceProvider") {}

const LiveAnswer = Schema.Struct({
  session: Schema.Struct({ id: Schema.String }),
  transport: Schema.Struct({ sdp: Schema.String }),
});
const isVoiceError = Schema.is(VoiceError);
export const voiceModel = (mode: VoiceStartInput["mode"]) =>
  mode === "dictation" ? "gpt-live-transcribe" : "gpt-live-1";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);
const make = Effect.gen(function* () {
  const audit = yield* VoiceAuditLog.VoiceAuditLog;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const active = new Map<string, { apiKey: string; mode: VoiceStartInput["mode"] }>();
  const key = Effect.gen(function* () {
    const stored = yield* secrets
      .get("voice-openai")
      .pipe(
        Effect.mapError((error) =>
          isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
        ),
      );
    return Option.isSome(stored)
      ? new TextDecoder().decode(stored.value)
      : // Product call for Lauren: an unset saved voice key falls back to OPENAI_API_KEY.
        ((yield* HostProcess.Environment).OPENAI_API_KEY?.trim() ?? "");
  });
  const configure = Effect.fn("VoiceProvider.configure")(function* (apiKey: string) {
    yield* (
      apiKey.trim()
        ? secrets.set("voice-openai", new TextEncoder().encode(apiKey.trim()))
        : secrets.remove("voice-openai")
    ).pipe(
      Effect.mapError((error) =>
        isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
      ),
    );
  });
  const logStartFailure = (mode: VoiceStartInput["mode"], startedAt: number, error: unknown) => {
    const facts = voiceErrorFacts(error);
    return Effect.gen(function* () {
      const latencyMs = Math.max(0, DateTime.toEpochMillis(yield* DateTime.now) - startedAt);
      yield* audit.append("provider-start", {
        type: "error",
        mode,
        where: "provider.start",
        reason: isVoiceError(error) ? error.reason : "provider",
        ...(facts.providerType === undefined ? {} : { providerType: facts.providerType }),
        message: facts.message,
        latencyMs,
      });
    });
  };
  const start = Effect.fn("VoiceProvider.start")(function* (input: VoiceStartInput) {
    const apiKey = yield* key;
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    if (!apiKey) {
      const missing = new VoiceError({ reason: "not_configured" });
      yield* logStartFailure(input.mode, startedAt, missing);
      return yield* missing;
    }
    const result = yield* Effect.gen(function* () {
      let opened: VoiceStartResult;
      if (input.mode === "dictation") {
        const form = new FormData();
        form.set("sdp", input.sdp);
        form.set(
          "session",
          encodeJson({
            type: "transcription",
            audio: {
              input: { transcription: { model: voiceModel("dictation") }, turn_detection: null },
            },
          }),
        );
        const response = yield* http.execute(
          HttpClientRequest.post("https://api.openai.com/v1/realtime/calls").pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.bodyFormData(form),
          ),
        );
        const sessionId = response.headers.location?.split("/").at(-1);
        if (!sessionId) return yield* new VoiceError({ reason: "provider" });
        opened = { sessionId, sdp: yield* response.text };
      } else {
        const response = yield* http.execute(
          HttpClientRequest.post("https://api.openai.com/v1/live/sessions").pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.setHeader("OpenAI-Beta", "live=v1"),
            HttpClientRequest.bodyJsonUnsafe({
              session: {
                model: voiceModel("call"),
                instructions: LIVE_SYSTEM_INSTRUCTIONS,
                delegation: {
                  type: "responses",
                  responses: {
                    model: "gpt-5.6-luna",
                    instructions: LIVE_SYSTEM_INSTRUCTIONS,
                    tools: buildLiveFunctionTools(),
                    tool_choice: "auto",
                    parallel_tool_calls: false,
                  },
                },
              },
              transport: { type: "webrtc", sdp: input.sdp },
            }),
          ),
        );
        const answer = yield* HttpClientResponse.schemaBodyJson(LiveAnswer)(response);
        opened = { sessionId: answer.session.id, sdp: answer.transport.sdp };
      }
      return opened;
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.tapError((error) => logStartFailure(input.mode, startedAt, error)),
      Effect.mapError((error) =>
        isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
      ),
    );
    const latencyMs = Math.max(0, DateTime.toEpochMillis(yield* DateTime.now) - startedAt);
    active.set(result.sessionId, { apiKey, mode: input.mode });
    yield* audit.append(result.sessionId, {
      type: "connect",
      mode: input.mode,
      attempt: 1,
      latencyMs,
    });
    return result;
  });
  const end = Effect.fn("VoiceProvider.end")(function* (sessionId: string) {
    const session = active.get(sessionId);
    if (!session) return;
    active.delete(sessionId);
    const logClose = (error: unknown) => {
      const facts = voiceErrorFacts(error);
      return audit.append(sessionId, {
        type: "error",
        mode: session.mode,
        where: "provider.sideband",
        reason: "provider",
        ...(facts.providerType === undefined ? {} : { providerType: facts.providerType }),
        message: facts.message,
      });
    };
    if (session.mode === "dictation") {
      const hangup = yield* http
        .execute(
          HttpClientRequest.post(
            `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(sessionId)}/hangup`,
          ).pipe(HttpClientRequest.bearerToken(session.apiKey)),
        )
        .pipe(Effect.timeoutOption("5 seconds"), Effect.exit);
      if (Exit.isFailure(hangup)) yield* logClose(Cause.squash(hangup.cause));
      return;
    }
    // Sideband releases the provider session even when the media client disconnected.
    const sideband: { error?: unknown; code?: number } = {};
    yield* Effect.callback<void, VoiceError>((resume) => {
      const socket = new WebSocket(
        `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
        { headers: { Authorization: `Bearer ${session.apiKey}`, "OpenAI-Beta": "live=v1" } },
      );
      socket.on("open", () => socket.send(encodeJson({ type: "session.close" })));
      socket.on("message", (data) => {
        const event = decodeEvent(String(data));
        if (Option.isSome(event) && event.value.type === "session.closed") resume(Effect.void);
      });
      socket.on("error", (error) => {
        sideband.error = error;
        resume(Effect.void);
      });
      socket.on("close", (code) => {
        if (sideband.error === undefined && code !== 1000 && code !== 1005) sideband.code = code;
        resume(Effect.void);
      });
      return Effect.sync(() => socket.terminate());
    }).pipe(Effect.timeoutOption("5 seconds"));
    if (sideband.error !== undefined) yield* logClose(sideband.error);
    else if (sideband.code !== undefined)
      yield* logClose({ _tag: "SidebandClose", message: `closed ${sideband.code}` });
  });
  return VoiceProvider.of({
    status: key.pipe(Effect.map((value) => ({ configured: value.length > 0 }))),
    configure,
    start,
    end,
  });
});
export const layer = Layer.effect(VoiceProvider, make);
