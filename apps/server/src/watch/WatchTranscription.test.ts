import { assert, test } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import { ThreadId, type WatchThreadSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as WatchService from "./WatchService.ts";
import * as WatchTranscription from "./WatchTranscription.ts";
import * as LocalTranscription from "../transcription/LocalTranscription.ts";

const it = makeMethods(test);
const threadId = ThreadId.make("voice-thread");
const recording = { audioBase64: Buffer.from("recorded-audio").toString("base64") };

it.effect("authorizes the thread before transcription and never dispatches", () => {
  let transcriptions = 0;
  let requestedRestriction: unknown;
  const layer = WatchTranscription.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WatchService.WatchService)({
          getThread: (input) => {
            requestedRestriction = input.restriction;
            return Effect.fail(new WatchService.WatchServiceError({ code: "forbidden" }));
          },
          submitCommand: () => Effect.die("Transcription must never send a message"),
        }),
        Layer.succeed(LocalTranscription.LocalTranscription, {
          transcribe: () => {
            transcriptions++;
            return Effect.succeed("text");
          },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* WatchTranscription.WatchTranscription;
    const restriction = { threadIds: [ThreadId.make("another-thread")] };
    const error = yield* service.transcribe({ threadId, recording, restriction }).pipe(Effect.flip);
    assert.equal(error._tag, "WatchServiceError");
    assert.deepEqual(requestedRestriction, restriction);
    assert.equal(transcriptions, 0);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "returns a transcript without sending, and rejects malformed audio before the engine",
  () => {
    const received: Uint8Array[] = [];
    const layer = WatchTranscription.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(WatchService.WatchService)({
            getThread: () => Effect.succeed({ isReadOnly: false } as WatchThreadSummary),
            submitCommand: () => Effect.die("Transcription must never send a message"),
          }),
          Layer.succeed(LocalTranscription.LocalTranscription, {
            transcribe: (audio) => {
              received.push(audio);
              return Effect.succeed("Run the tests.");
            },
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* WatchTranscription.WatchTranscription;
      assert.deepEqual(yield* service.transcribe({ threadId, recording }), {
        text: "Run the tests.",
      });
      assert.equal(Buffer.from(received[0]!).toString(), "recorded-audio");
      for (const audioBase64 of ["!!!", "YQ", "", Buffer.alloc(1_048_577).toString("base64")]) {
        const error = yield* service
          .transcribe({ threadId, recording: { audioBase64 } })
          .pipe(Effect.flip);
        assert.equal(error._tag, "TranscriptionError");
      }
      assert.equal(received.length, 1);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("rejects read-only subagents before transcription", () =>
  Effect.gen(function* () {
    const service = yield* WatchTranscription.WatchTranscription;
    const error = yield* service.transcribe({ threadId, recording }).pipe(Effect.flip);
    assert.equal(error._tag === "WatchServiceError" && error.code, "thread_read_only");
  }).pipe(
    Effect.provide(
      WatchTranscription.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(WatchService.WatchService)({
              getThread: () => Effect.succeed({ isReadOnly: true } as WatchThreadSummary),
            }),
            Layer.succeed(LocalTranscription.LocalTranscription, {
              transcribe: () => Effect.die("Read-only thread reached transcription"),
            }),
          ),
        ),
      ),
    ),
  ),
);
