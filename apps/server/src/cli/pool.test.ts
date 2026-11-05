import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command } from "effect/cli";

import { resolveCliAuthConfig } from "./config.ts";
import { POOL_DEV_FLAG, poolCommand } from "./pool.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))((it) =>
  it.effect("refuses to mark an instance spent unless the dev flag is on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-cli-" });
      const run = (env: Record<string, string>) =>
        Command.runWith(poolCommand, { version: "0.0.0" })([
          "mark-spent",
          "cursor_pool",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        );
      const { settingsPath } = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        Option.none(),
      ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))));
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true });
      const instance = { driver: "cursor", enabled: true, disableOnUsageLimit: true };
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({ providerInstances: { cursor_pool: instance } }),
      );
      const saved = () =>
        fs
          .readFileString(settingsPath)
          .pipe(Effect.map((text) => JSON.parse(text).providerInstances.cursor_pool));

      const refused = yield* Effect.flip(run({}));
      assert.include(refused.message, POOL_DEV_FLAG);
      assert.deepEqual(yield* saved(), instance);

      yield* run({ [POOL_DEV_FLAG]: "1" });
      const marked = yield* saved();
      assert.isFalse(marked.enabled);
      assert.isString(marked.usageLimitDisabled?.at);
    }),
  ),
);
