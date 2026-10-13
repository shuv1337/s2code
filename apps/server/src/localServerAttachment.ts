import {
  LOCAL_SERVER_ATTACHMENT_FILE,
  LocalServerAttachment,
} from "@t3tools/shared/localServerAttachment";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import packageJson from "../package.json" with { type: "json" };
import type * as ServerConfig from "./config.ts";

const encodeAttachment = Schema.encodeEffect(Schema.fromJsonString(LocalServerAttachment));
const decodeAttachment = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalServerAttachment));

export const withLocalDesktopBootstrap = Effect.fn("withLocalDesktopBootstrap")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  if (config.desktopBootstrapSecret || config.desktopBootstrapToken) return config;
  const crypto = yield* Crypto.Crypto;
  return { ...config, desktopBootstrapSecret: Hex.encode(yield* crypto.randomBytes(32)) };
});

export const persistLocalServerAttachment = Effect.fn("persistLocalServerAttachment")(function* (
  config: ServerConfig.ServerConfig["Service"],
  port: number,
) {
  if (!config.desktopBootstrapSecret) return;
  const path = yield* Path.Path;
  yield* writeFileStringAtomically({
    filePath: path.join(config.stateDir, LOCAL_SERVER_ATTACHMENT_FILE),
    mode: 0o600,
    contents: yield* encodeAttachment({
      version: 1,
      pid: process.pid,
      port,
      serverVersion: packageJson.version,
      bootstrapSecret: config.desktopBootstrapSecret,
    }),
  });
});

export const clearLocalServerAttachment = Effect.fn("clearLocalServerAttachment")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const file = path.join(stateDir, LOCAL_SERVER_ATTACHMENT_FILE);
  const record = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeAttachment),
    Effect.orElseSucceed(() => null),
  );
  if (record?.pid === process.pid) yield* fs.remove(file, { force: true });
});
