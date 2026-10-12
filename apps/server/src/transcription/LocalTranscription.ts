import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { OfflineRecognizer } from "sherpa-onnx-node";
import * as LocalSpeechModel from "./LocalSpeechModel.ts";

export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()(
  "TranscriptionError",
  {
    code: Schema.Literals([
      "transcription_unavailable",
      "transcription_busy",
      "invalid_audio",
      "transcription_failed",
      "speech_model_unavailable",
      "no_speech",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.code) {
      case "transcription_unavailable":
        return "Local transcription is unavailable on this server installation.";
      case "transcription_busy":
        return "The server is transcribing another recording. Retry shortly.";
      case "invalid_audio":
        return "Record an AAC clip of up to two minutes.";
      case "speech_model_unavailable":
        return "The speech model could not be prepared. Check the server's connection and free disk space, then retry.";
      case "no_speech":
        return "No speech was heard. Try recording again.";
      case "transcription_failed":
        return "Transcription failed. Your recording can be retried.";
    }
  }
}

export class LocalTranscription extends Context.Service<
  LocalTranscription,
  {
    readonly transcribe: (audio: Uint8Array) => Effect.Effect<string, TranscriptionError>;
  }
>()("t3/transcription/LocalTranscription") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const model = yield* LocalSpeechModel.LocalSpeechModel;
  const semaphore = yield* Semaphore.make(1);
  let recognizer: OfflineRecognizer | undefined;

  const transcribe = Effect.fn("LocalTranscription.transcribe")(function* (audio: Uint8Array) {
    if (audio.byteLength === 0 || audio.byteLength > 1_048_576) {
      return yield* new TranscriptionError({ code: "invalid_audio" });
    }
    const work = Effect.gen(function* () {
      const ffmpeg = yield* Effect.tryPromise(() => import("ffmpeg-static")).pipe(
        Effect.map((module) => module.default),
        Effect.mapError(
          (cause) => new TranscriptionError({ code: "transcription_unavailable", cause }),
        ),
      );
      if (typeof ffmpeg !== "string")
        return yield* new TranscriptionError({ code: "transcription_unavailable" });
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-" });
      const input = path.join(temporary, "recording.m4a");
      const output = path.join(temporary, "samples.f32");
      yield* fs.writeFile(input, audio, { mode: 0o600 });
      // Force the uploaded container and local protocols; never accept playlists or URLs.
      const exit = yield* spawner
        .exitCode(
          ChildProcess.make(
            ffmpeg,
            [
              "-nostdin",
              "-hide_banner",
              "-loglevel",
              "error",
              "-protocol_whitelist",
              "file,pipe",
              "-f",
              "mov",
              "-i",
              input,
              "-map",
              "0:a:0",
              "-vn",
              "-ac",
              "1",
              "-ar",
              "16000",
              "-t",
              "121",
              "-f",
              "f32le",
              output,
            ],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          ),
        )
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => new TranscriptionError({ code: "invalid_audio", cause })),
        );
      if (Number(exit) !== 0) return yield* new TranscriptionError({ code: "invalid_audio" });
      const pcm = yield* fs.readFile(output);
      const sampleCount = pcm.byteLength / 4;
      if (!Number.isInteger(sampleCount) || sampleCount < 1600 || sampleCount > 16000 * 120.25) {
        return yield* new TranscriptionError({ code: "invalid_audio" });
      }
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const samples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) samples[i] = view.getFloat32(i * 4, true);
      if (!samples.every(Number.isFinite))
        return yield* new TranscriptionError({ code: "invalid_audio" });
      if (!recognizer) {
        const directory = yield* model.prepare.pipe(
          Effect.mapError(
            (cause) => new TranscriptionError({ code: "speech_model_unavailable", cause }),
          ),
        );
        recognizer = yield* Effect.tryPromise(async () => {
          const { default: sherpa } = await import("sherpa-onnx-node");
          return sherpa.OfflineRecognizer.createAsync({
            featConfig: { sampleRate: 16000, featureDim: 80 },
            modelConfig: {
              transducer: {
                encoder: path.join(directory, "encoder.int8.onnx"),
                decoder: path.join(directory, "decoder.int8.onnx"),
                joiner: path.join(directory, "joiner.int8.onnx"),
              },
              tokens: path.join(directory, "tokens.txt"),
              numThreads: 2,
              provider: "cpu",
              modelType: "nemo_transducer",
            },
          });
        }).pipe(
          Effect.uninterruptible,
          Effect.mapError(
            (cause) => new TranscriptionError({ code: "transcription_unavailable", cause }),
          ),
        );
      }
      const activeRecognizer = recognizer;
      // The addon is asynchronous but cannot cancel a decode. Retain its permit
      // until it settles so a disconnected Watch cannot start concurrent decodes.
      const text = yield* Effect.tryPromise(async () => {
        const stream = activeRecognizer.createStream();
        stream.acceptWaveform({ sampleRate: 16000, samples });
        return (await activeRecognizer.decodeAsync(stream)).text.trim();
      }).pipe(
        Effect.uninterruptible,
        Effect.mapError((cause) => new TranscriptionError({ code: "transcription_failed", cause })),
      );
      if (!text) return yield* new TranscriptionError({ code: "no_speech" });
      return text;
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new TranscriptionError({ code: "transcription_failed", cause })),
      }),
    );
    const result = yield* semaphore.withPermitsIfAvailable(1)(work);
    return Option.isSome(result)
      ? result.value
      : yield* new TranscriptionError({ code: "transcription_busy" });
  });
  return LocalTranscription.of({ transcribe });
});

export const layer = Layer.effect(LocalTranscription, make);
