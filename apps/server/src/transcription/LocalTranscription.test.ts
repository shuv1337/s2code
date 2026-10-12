import { assert, test, vi, beforeEach } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as LocalTranscription from "./LocalTranscription.ts";
import * as LocalSpeechModel from "./LocalSpeechModel.ts";

const native = vi.hoisted(() => ({
  decode: vi.fn<() => Promise<{ text: string }>>(),
  create: vi.fn<() => Promise<unknown>>(),
}));
vi.mock("sherpa-onnx-node", () => ({
  default: { OfflineRecognizer: { createAsync: native.create } },
}));
beforeEach(() => {
  native.decode.mockReset().mockResolvedValue({ text: "Run the tests." });
  native.create.mockReset().mockResolvedValue({
    createStream: () => ({ acceptWaveform: () => {} }),
    decodeAsync: native.decode,
  });
});
const it = makeMethods(test);
const layer = LocalTranscription.layer.pipe(
  Layer.provide(
    Layer.succeed(LocalSpeechModel.LocalSpeechModel, { prepare: Effect.succeed("/model") }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const clip = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFile(new URL("./fixtures/instruction.m4a", import.meta.url).pathname);
});

it.effect("decodes AAC, reuses the native model, and returns text", () =>
  Effect.gen(function* () {
    const service = yield* LocalTranscription.LocalTranscription;
    const audio = yield* clip;
    assert.equal(yield* service.transcribe(audio), "Run the tests.");
    assert.equal(yield* service.transcribe(audio), "Run the tests.");
    assert.equal(native.create.mock.calls.length, 1);
    assert.equal(native.decode.mock.calls.length, 2);
  }).pipe(Effect.provide(layer)),
);
it.effect("malformed and oversized audio never loads the model", () =>
  Effect.gen(function* () {
    const service = yield* LocalTranscription.LocalTranscription;
    for (const audio of [
      new Uint8Array(),
      new Uint8Array(1_048_577),
      new TextEncoder().encode("not audio"),
    ]) {
      assert.equal((yield* service.transcribe(audio).pipe(Effect.flip)).code, "invalid_audio");
    }
    assert.equal(native.create.mock.calls.length, 0);
  }).pipe(Effect.provide(layer)),
);
it.effect("a cancelled native decode retains its permit until it settles", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<{ text: string }>();
    native.decode.mockImplementationOnce(() => {
      started.resolve();
      return finish.promise;
    });
    const service = yield* LocalTranscription.LocalTranscription;
    const audio = yield* clip;
    const first = yield* service.transcribe(audio).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    const interrupt = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
    assert.equal((yield* service.transcribe(audio).pipe(Effect.flip)).code, "transcription_busy");
    finish.resolve({ text: "done" });
    yield* Fiber.join(interrupt);
    assert.equal(yield* service.transcribe(audio), "Run the tests.");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
it.effect("native failure releases the slot and silence is not submitted", () =>
  Effect.gen(function* () {
    const service = yield* LocalTranscription.LocalTranscription;
    const audio = yield* clip;
    native.decode.mockRejectedValueOnce(new Error("synthetic native failure"));
    assert.equal((yield* service.transcribe(audio).pipe(Effect.flip)).code, "transcription_failed");
    native.decode.mockResolvedValueOnce({ text: "  " });
    assert.equal((yield* service.transcribe(audio).pipe(Effect.flip)).code, "no_speech");
    assert.equal(yield* service.transcribe(audio), "Run the tests.");
  }).pipe(Effect.provide(layer)),
);
