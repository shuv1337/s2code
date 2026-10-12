// @effect-diagnostics nodeBuiltinImport:off - Native packages must resolve beside the SEA executable.
import * as NodeModule from "node:module";

const requireNative = NodeModule.createRequire(import.meta.url);
export const loadFfmpeg = () => requireNative("ffmpeg-static") as string | null;
export const loadSherpa = () =>
  requireNative("sherpa-onnx-node") as typeof import("sherpa-onnx-node").default;
