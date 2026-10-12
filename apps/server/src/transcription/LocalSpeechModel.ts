// @effect-diagnostics nodeBuiltinImport:off - Incremental hashing keeps the 652 MB model out of JS memory; Effect Crypto only digests whole buffers.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ServerConfig from "../config.ts";

// The English Parakeet v2 export maintained by sherpa-onnx. Pin both revision and
// content: a partial download must never reach the native model loader.
const revision = "1ab9323565ddb038682214b292f588070a538ce2";
const source = `https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/${revision}`;
const files = [
  {
    name: "encoder.int8.onnx",
    size: 652184296,
    sha256: "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab",
  },
  {
    name: "decoder.int8.onnx",
    size: 7257753,
    sha256: "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e",
  },
  {
    name: "joiner.int8.onnx",
    size: 1739080,
    sha256: "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2",
  },
  {
    name: "tokens.txt",
    size: 9384,
    sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d",
  },
] as const;

export class SpeechModelError extends Schema.TaggedError<SpeechModelError>()("SpeechModelError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "The local speech model could not be prepared. Check the server's connection and free disk space, then retry.";
  }
}

export class LocalSpeechModel extends Context.Service<
  LocalSpeechModel,
  {
    readonly prepare: Effect.Effect<string, SpeechModelError>;
  }
>()("t3/transcription/LocalSpeechModel") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const directory = path.join(config.stateDir, "speech-models", `parakeet-v2-int8-${revision}`);

  const prepare = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true });
    for (const file of files) {
      const destination = path.join(directory, file.name);
      const valid = yield* Effect.gen(function* () {
        const stat = yield* fs.stat(destination);
        if (Number(stat.size) !== file.size) return false;
        const hash = NodeCrypto.createHash("sha256");
        yield* fs.stream(destination).pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              hash.update(chunk);
            }),
          ),
        );
        return hash.digest("hex") === file.sha256;
      }).pipe(Effect.orElseSucceed(() => false));
      if (valid) continue;
      const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".download-" });
      const partial = path.join(temporary, file.name);
      const response = yield* http.get(`${source}/${file.name}`);
      const hash = NodeCrypto.createHash("sha256");
      let bytes = 0;
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            bytes += chunk.byteLength;
            if (bytes > file.size)
              return yield* Effect.fail(
                new SpeechModelError({ cause: { file: file.name, reason: "size" } }),
              );
            hash.update(chunk);
          }),
        ),
        Stream.run(fs.sink(partial)),
      );
      if (bytes !== file.size || hash.digest("hex") !== file.sha256) {
        return yield* Effect.fail(
          new SpeechModelError({ cause: { file: file.name, reason: "integrity" } }),
        );
      }
      yield* fs.rename(partial, destination);
    }
    return directory;
  }).pipe(
    Effect.scoped,
    Effect.timeout("10 minutes"),
    Effect.mapError((cause) => new SpeechModelError({ cause })),
  );
  return LocalSpeechModel.of({ prepare });
});

export const layer = Layer.effect(LocalSpeechModel, make);
