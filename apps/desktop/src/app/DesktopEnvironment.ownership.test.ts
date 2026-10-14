import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { afterEach, vi } from "vite-plus/test";
import { resolveProductEnvironment } from "@t3tools/shared/productIdentity";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";
import * as Logger from "effect/Logger";

afterEach(() => vi.unstubAllEnvs());
const ownedEnvironment = (
  homeDirectory: string,
  channel: string,
  env: Record<string, string> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layerOwned({
        dirname: homeDirectory,
        homeDirectory,
        appPath: homeDirectory,
        resourcesPath: homeDirectory,
        platform: "darwin",
        processArch: "arm64",
        isPackaged: true,
        appVersion: `1.2.3-${channel}.20261014.1`,
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            DesktopConfig.layerTest(resolveProductEnvironment(env)),
          ),
        ),
      ),
    ),
  );

it.effect.each(["nightly", "preview"])(
  "logs shared data after layerOwned has already claimed the %s home",
  (channel) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      vi.stubEnv("HOME", root);
      vi.stubEnv("USERPROFILE", root);
      const stable = path.join(root, ".shuv2code-v2");
      yield* fs.makeDirectory(stable);
      yield* fs.writeFileString(path.join(stable, "state.sqlite"), "old-shared-data");
      const environment = yield* ownedEnvironment(root, channel);
      expect(yield* fs.exists(path.join(environment.baseDir, ".product-identity"))).toBe(true);
      const messages: string[] = [];
      yield* resolveUserDataPath({
        appDataDirectory: root,
        homeDirectory: root,
        baseDir: environment.baseDir,
        appVersion: `1.2.3-${channel}.20261014.1`,
        isDevelopment: false,
        platform: "darwin",
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              messages.push(String(options.message));
            }),
          ]),
        ),
      );
      expect(
        messages.some(
          (message) => message.includes(stable) && message.includes("remains untouched"),
        ),
      ).toBe(true);
      expect(yield* fs.readFileString(path.join(stable, "state.sqlite"))).toBe("old-shared-data");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["nightly", "preview"])(
  "validates the resolved %s home without claiming the stable home",
  (channel) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      vi.stubEnv("HOME", root);
      vi.stubEnv("USERPROFILE", root);
      const stable = path.join(root, ".shuv2code-v2");
      yield* fs.makeDirectory(stable);
      yield* fs.writeFileString(path.join(stable, ".product-identity"), "t3code\n");
      const home = path.join(root, `.shuv2code-v2-${channel}`);
      yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".product-identity"), "shuv2code\n");
      yield* fs.writeFileString(
        path.join(home, "userdata", "statev2.sqlite"),
        "existing-channel-state",
      );
      const environment = yield* ownedEnvironment(root, channel, { T3CODE_HOME: stable });
      expect(environment.baseDir).toBe(home);
      expect(yield* fs.readFileString(path.join(home, ".product-identity"))).toBe("shuv2code\n");
      expect(yield* fs.readFileString(path.join(home, "userdata", "statev2.sqlite"))).toBe(
        "existing-channel-state",
      );
      expect(yield* fs.readFileString(path.join(stable, ".product-identity"))).toBe("t3code\n");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["nightly", "preview"])(
  "refuses upstream-like state in the exact %s home and claims a fresh home first",
  (channel) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      vi.stubEnv("HOME", root);
      vi.stubEnv("USERPROFILE", root);
      const home = path.join(root, `.shuv2code-v2-${channel}`);
      const state = path.join(home, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
      yield* fs.writeFileString(state, "upstream-state");
      const error = yield* ownedEnvironment(root, channel).pipe(Effect.flip);
      expect(error.cause).toMatchObject({
        message: expect.stringContaining("Cannot establish product ownership"),
      });
      expect(yield* fs.readFileString(state)).toBe("upstream-state");
      expect(yield* fs.exists(path.join(home, ".product-identity"))).toBe(false);
      yield* fs.remove(home, { recursive: true });
      const environment = yield* ownedEnvironment(root, channel);
      expect(environment.baseDir).toBe(home);
      expect(yield* fs.readDirectory(home)).toEqual([".product-identity"]);
      expect(yield* fs.readFileString(path.join(home, ".product-identity"))).toBe("shuv2code\n");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses an unmarked custom channel home before claiming any home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const custom = path.join(root, "custom");
    yield* fs.makeDirectory(custom);
    yield* fs.writeFileString(path.join(custom, "statev2.sqlite"), "untouched");
    yield* ownedEnvironment(root, "nightly", { SHUV2CODE_HOME: custom }).pipe(Effect.flip);
    expect(yield* fs.readDirectory(custom)).toEqual(["statev2.sqlite"]);
    expect(yield* fs.exists(path.join(root, ".shuv2code-v2"))).toBe(false);
    expect(yield* fs.exists(path.join(root, ".shuv2code-v2-nightly"))).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
