import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";
import * as Logger from "effect/Logger";

it.effect.each(["nightly", "preview"])(
  "uses a separate %s profile and leaves the old shared home untouched",
  (channel) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "desktop-channel-home-" });
      const shared = path.join(home, ".shuv2code-v2");
      yield* fs.makeDirectory(shared);
      yield* fs.writeFileString(path.join(shared, "statev2.sqlite"), "original-db");
      const warnings: string[] = [];
      const baseDir = path.join(home, `.shuv2code-v2-${channel}`);
      const profile = yield* resolveUserDataPath({
        appDataDirectory: home,
        homeDirectory: home,
        baseDir,
        isDevelopment: false,
        platform: "darwin",
        appVersion: `1.2.3-${channel}.20261014.1`,
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              warnings.push(String(options.message));
            }),
          ]),
        ),
      );
      assert.equal(profile, path.join(home, `shuv2code-v2-${channel}`));
      assert.isFalse(yield* fs.exists(baseDir));
      assert.equal(yield* fs.readFileString(path.join(shared, "statev2.sqlite")), "original-db");
      assert.isTrue(
        warnings.some((message) => message.includes("Existing shared data remains untouched")),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("identifies a failed profile inspection and preserves its cause", () => {
  const sourceState = "/profiles/shuv2code-v2";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "exists",
    pathOrDescriptor: sourceState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "inspect");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect.each(["t3code", "t3code-v2", "T3 Code (Alpha)", "shuv2code", "shuv2code (Alpha)"])(
  "leaves %s untouched and starts without its Windows keys or databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "shuv2code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.isFalse(yield* fs.exists(path.join(destination, "Local State")));
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.makeDirectory(destination, { recursive: true });
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
