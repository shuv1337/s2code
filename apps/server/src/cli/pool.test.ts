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
  it.effect("is refused without the dev flag, and refusals never create the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = (
        baseDir: string,
        args: ReadonlyArray<string>,
        env: Record<string, string> = { [POOL_DEV_FLAG]: "1" },
      ) =>
        Command.runWith(poolCommand, { version: "0.0.0" })([...args, "--base-dir", baseDir]).pipe(
          Effect.provideService(HostProcess.Environment, env),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        );

      const untouched = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-cli-off-" });
      for (const env of [{}, { [POOL_DEV_FLAG]: "maybe" }]) {
        const refused = yield* Effect.flip(run(untouched, ["mark-spent", "cursor_pool"], env));
        assert.include(refused.message, POOL_DEV_FLAG);
      }
      assert.deepEqual(yield* fs.readDirectory(untouched), []);

      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-cli-" });
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        Option.none(),
      ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))));
      const instance = { driver: "cursor", enabled: true, disableOnUsageLimit: true };
      yield* fs.makeDirectory(path.dirname(config.settingsPath), { recursive: true });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ providerInstances: { cursor_pool: instance } }),
      );
      const saved = () =>
        fs
          .readFileString(config.settingsPath)
          .pipe(Effect.map((text) => JSON.parse(text).providerInstances.cursor_pool));

      const notSpent = yield* Effect.flip(run(baseDir, ["restore", "cursor_pool"]));
      assert.include(notSpent.message, "not marked spent");
      const unknown = yield* Effect.flip(run(baseDir, ["mark-spent", "cursor_missing"]));
      assert.include(unknown.message, "cursor_missing was not changed");
      assert.isFalse(yield* fs.exists(config.dbPath));
      assert.deepEqual(yield* saved(), instance);

      yield* run(baseDir, ["mark-spent", "cursor_pool"]);
      const marked = yield* saved();
      assert.isFalse(marked.enabled);
      assert.isString(marked.usageLimitDisabled?.at);

      yield* run(baseDir, ["restore", "cursor_pool"]);
      assert.deepEqual(yield* saved(), instance);
      const again = yield* Effect.flip(run(baseDir, ["restore", "cursor_pool"]));
      assert.include(again.message, "not marked spent");
    }),
  ),
);
