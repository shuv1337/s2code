import {
  WATCH_MAX_AUDIO_BYTES,
  WATCH_MAX_TEXT_BYTES,
  WATCH_MAX_TEXT_CODE_POINTS,
  type ThreadId,
  type WatchTranscriptionRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LocalTranscription from "../transcription/LocalTranscription.ts";
import * as WatchService from "./WatchService.ts";
import type { WatchRestriction } from "./WatchProjection.ts";

export class WatchTranscription extends Context.Service<
  WatchTranscription,
  {
    readonly transcribe: (input: {
      readonly threadId: ThreadId;
      readonly restriction?: WatchRestriction | undefined;
      readonly recording: WatchTranscriptionRequest;
    }) => Effect.Effect<
      { text: string },
      | WatchService.WatchServiceError
      | WatchService.WatchStorageError
      | LocalTranscription.TranscriptionError
    >;
  }
>()("t3/watch/WatchTranscription") {}

const make = Effect.gen(function* () {
  const threads = yield* WatchService.WatchService;
  const speech = yield* LocalTranscription.LocalTranscription;
  const transcribe = Effect.fn("WatchTranscription.transcribe")(function* (input: {
    readonly threadId: ThreadId;
    readonly restriction?: WatchRestriction | undefined;
    readonly recording: WatchTranscriptionRequest;
  }) {
    // Authorize the target before loading a model or decoding any audio.
    const thread = yield* threads.getThread(input);
    if (thread.isReadOnly)
      return yield* new WatchService.WatchServiceError({ code: "thread_read_only" });
    const audio = Buffer.from(input.recording.audioBase64, "base64");
    if (
      audio.byteLength === 0 ||
      audio.byteLength > WATCH_MAX_AUDIO_BYTES ||
      audio.toString("base64") !== input.recording.audioBase64
    ) {
      return yield* new LocalTranscription.TranscriptionError({ code: "invalid_audio" });
    }
    const text = yield* speech.transcribe(audio);
    if (
      [...text].length > WATCH_MAX_TEXT_CODE_POINTS ||
      Buffer.byteLength(text) > WATCH_MAX_TEXT_BYTES
    ) {
      return yield* new WatchService.WatchServiceError({ code: "text_too_long" });
    }
    return { text };
  });
  return WatchTranscription.of({ transcribe });
});
export const layer = Layer.effect(WatchTranscription, make);
