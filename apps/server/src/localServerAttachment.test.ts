import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { LOCAL_SERVER_ATTACHMENT_FILE } from "@t3tools/shared/localServerAttachment";
import * as ServerConfig from "./config.ts";
import {
  clearLocalServerAttachment,
  persistLocalServerAttachment,
  withLocalDesktopBootstrap,
} from "./localServerAttachment.ts";

it.effect(
  "publishes private process-lifetime credentials without changing public runtime metadata",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const config = yield* withLocalDesktopBootstrap(yield* ServerConfig.ServerConfig).pipe(
        Effect.map((config) => ({ ...config, stateDir: baseDir })),
      );
      assert.match(config.desktopBootstrapSecret!, /^[a-f0-9]{64}$/);
      yield* persistLocalServerAttachment(config, 3773);
      const file = path.join(baseDir, LOCAL_SERVER_ATTACHMENT_FILE);
      assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
      assert.equal(yield* fs.exists(path.join(baseDir, "server-runtime.json")), false);
      yield* clearLocalServerAttachment(baseDir);
      assert.equal(yield* fs.exists(file), false);
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          version: 1,
          pid: process.pid + 1,
          port: 3773,
          serverVersion: "test",
          bootstrapSecret: "other-server",
        }),
      );
      yield* clearLocalServerAttachment(baseDir);
      assert.equal(yield* fs.exists(file), true);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "attachment-test-" }),
          NodeServices.layer,
        ),
      ),
    ),
);
