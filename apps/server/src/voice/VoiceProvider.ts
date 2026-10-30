import { VoiceError, type VoiceStartInput, type VoiceStartResult } from "@t3tools/contracts";
import { buildLiveFunctionTools, LIVE_SYSTEM_INSTRUCTIONS } from "@t3tools/shared/voice/liveTools";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);
const make = Effect.gen(function* () {
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
      : (process.env.OPENAI_API_KEY?.trim() ?? "");
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
  const start = Effect.fn("VoiceProvider.start")(
    function* (input: VoiceStartInput) {
      const apiKey = yield* key;
      if (!apiKey) return yield* new VoiceError({ reason: "not_configured" });
      let result: VoiceStartResult;
      if (input.mode === "dictation") {
        const form = new FormData();
        form.set("sdp", input.sdp);
        form.set(
          "session",
          encodeJson({
            type: "transcription",
            audio: {
              input: { transcription: { model: "gpt-live-transcribe" }, turn_detection: null },
            },
          }),
        );
        const response = yield* http
          .execute(
            HttpClientRequest.post("https://api.openai.com/v1/realtime/calls").pipe(
              HttpClientRequest.bearerToken(apiKey),
              HttpClientRequest.bodyFormData(form),
            ),
          )
          .pipe(
            Effect.mapError((error) =>
              isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
            ),
          );
        const sessionId = response.headers.location?.split("/").at(-1);
        if (!sessionId) return yield* new VoiceError({ reason: "provider" });
        const sdp = yield* response.text.pipe(
          Effect.mapError((error) =>
            isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
          ),
        );
        result = { sessionId, sdp };
      } else {
        const response = yield* http
          .execute(
            HttpClientRequest.post("https://api.openai.com/v1/live/sessions").pipe(
              HttpClientRequest.bearerToken(apiKey),
              HttpClientRequest.setHeader("OpenAI-Beta", "live=v1"),
              HttpClientRequest.bodyJsonUnsafe({
                session: {
                  model: "gpt-live-1",
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
          )
          .pipe(
            Effect.mapError((error) =>
              isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
            ),
          );
        const answer = yield* HttpClientResponse.schemaBodyJson(LiveAnswer)(response).pipe(
          Effect.mapError((error) =>
            isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
          ),
        );
        result = { sessionId: answer.session.id, sdp: answer.transport.sdp };
      }
      active.set(result.sessionId, { apiKey, mode: input.mode });
      return result;
    },
    Effect.timeout("30 seconds"),
    Effect.mapError((error) =>
      isVoiceError(error) ? error : new VoiceError({ reason: "provider" }),
    ),
  );
  const end = Effect.fn("VoiceProvider.end")(function* (sessionId: string) {
    const session = active.get(sessionId);
    if (!session) return;
    active.delete(sessionId);
    if (session.mode === "dictation") {
      yield* http
        .execute(
          HttpClientRequest.post(
            `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(sessionId)}/hangup`,
          ).pipe(HttpClientRequest.bearerToken(session.apiKey)),
        )
        .pipe(Effect.timeoutOption("5 seconds"), Effect.ignore);
      return;
    }
    // Sideband releases the provider session even when the media client disconnected.
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
      socket.on("error", () => resume(Effect.void));
      socket.on("close", () => resume(Effect.void));
      return Effect.sync(() => socket.terminate());
    }).pipe(Effect.timeoutOption("5 seconds"));
  });
  return VoiceProvider.of({
    status: key.pipe(Effect.map((value) => ({ configured: value.length > 0 }))),
    configure,
    start,
    end,
  });
});
export const layer = Layer.effect(VoiceProvider, make);
