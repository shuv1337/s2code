import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { HttpClient } from "effect/http";
import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";

import {
  repointLauncher,
  resolveLauncherPath,
  runUpdate,
  isForkBootServiceCgroup,
  formatUpdatedLauncherCommand,
} from "./update.ts";

it("recognizes only exact fork boot service cgroup components", () => {
  for (const unit of ["shuv2code-v2", "shuv2code-v2-nightly", "shuv2code-v2-preview"]) {
    assert.isTrue(isForkBootServiceCgroup(`0::/user.slice/${unit}.service\n`));
    assert.isTrue(isForkBootServiceCgroup(`0::/user.slice/${unit}.service/child`));
  }
  for (const unit of ["t3code.service", "shuv2code-v2.service-other", "not-shuv2code-v2.service"])
    assert.isFalse(isForkBootServiceCgroup(`0::/user.slice/${unit}`));
});

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect.each(["1.2.3", "1.2.3-nightly.20261014.1", "1.2.3-preview.20261014.1"])(
    "rejects cross-channel flags and exact versions from %s without side effects",
    (currentVersion) =>
      Effect.gen(function* () {
        for (const [channel, requestedVersion] of [
          ["stable", "1.3.0"],
          ["nightly", "1.3.0-nightly.20261014.2"],
          ["preview", "1.3.0-preview.20261014.2"],
        ] as const) {
          if (
            currentVersion.includes("-nightly.") === requestedVersion.includes("-nightly.") &&
            currentVersion.includes("-preview.") === requestedVersion.includes("-preview.")
          )
            continue;
          for (const selection of [
            { channel, requestedVersion: undefined },
            { channel: undefined, requestedVersion },
          ]) {
            const error = yield* runUpdate({
              ...selection,
              currentVersion,
              baseDir: "/never-touch",
              logsDir: "/never-touch/logs",
              serverRuntimeStatePath: "/never-touch/runtime.json",
              allowDowngrade: true,
              assumeYes: true,
            }).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("must not download or query releases")),
              ),
              Effect.provideService(ProcessRunner.ProcessRunner, {
                run: () => Effect.die("must not spawn"),
              }),
              Effect.provideService(BootService.BootService, {
                status: Effect.die("must not inspect services"),
                install: () => Effect.die("must not install services"),
                restart: Effect.die("must not restart services"),
                withStopped: () => Effect.die("must not stop services"),
                uninstall: Effect.die("must not uninstall services"),
              }),
              Effect.flip,
            );
            assert.include(error.message, "Install the other channel separately");
          }
        }
      }),
  );

  it.effect.each(["nightly", "preview"])("repoints only the owned %s Windows shim", (channel) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "channel-shim-" });
      const version = `1.2.3-${channel}.20261014.1`;
      const oldExe = path.join(root, "runtime", "versions", version, "t3.exe");
      const newExe = path.join(
        root,
        "runtime",
        "versions",
        `1.3.0-${channel}.20261014.2`,
        "t3.exe",
      );
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin);
      const content = `@echo off\r\n"${oldExe}" %*`;
      const stableShim = path.join(bin, "shuv2code.cmd");
      const shim = path.join(bin, `shuv2code-${channel}.cmd`);
      yield* fs.writeFileString(stableShim, content);
      yield* fs.writeFileString(shim, content);
      const repointed = yield* repointLauncher({
        currentVersion: version,
        launchedAs: oldExe,
        versionsDir: path.join(root, "runtime", "versions"),
        targetEntryPath: newExe,
      }).pipe(Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: bin }));
      assert.equal(Option.getOrUndefined(repointed), shim);
      assert.include(yield* fs.readFileString(shim), newExe);
      assert.equal(yield* fs.readFileString(stableShim), content);
      const foreign = `@echo off\r\n"${path.join(root, "other-home", "t3.exe")}" %*`;
      yield* fs.writeFileString(shim, foreign);
      const ignored = yield* repointLauncher({
        currentVersion: version,
        launchedAs: oldExe,
        versionsDir: path.join(root, "runtime", "versions"),
        targetEntryPath: newExe,
      }).pipe(Effect.provideService(HostProcess.Environment, { T3CODE_INSTALL_BIN_DIR: bin }));
      assert.equal(ignored._tag, "None");
      assert.equal(yield* fs.readFileString(shim), foreign);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
  it.effect("repoints a symlink that lives in a runtime versions tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const launcher = path.join(root, "bin/t3");
      for (const file of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.symlink(oldExe, launcher);

      const repointed = yield* repointLauncher({
        launchedAs: launcher,
        versionsDir: path.join(root, "runtime/versions"),
        targetEntryPath: newExe,
      });

      assert.deepStrictEqual(Option.getOrUndefined(repointed), launcher);
      assert.equal(yield* fs.readLink(launcher), newExe);
      assert.equal(
        formatUpdatedLauncherCommand(Option.getOrThrow(repointed), "/fork home"),
        `'${launcher}' serve --base-dir '/fork home'`,
      );
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves a plain copy or a foreign symlink alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const newExe = path.join(root, "runtime/versions/2.0.0/t3");
      const copy = path.join(root, "copy/t3");
      const foreign = path.join(root, "foreign/t3");
      const elsewhere = path.join(root, "elsewhere/t3");
      const otherHome = path.join(root, "other/runtime/versions/1.0.0/t3");
      const otherLauncher = path.join(root, "other/bin/t3");
      for (const file of [newExe, copy, elsewhere, otherHome]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(foreign), { recursive: true });
      yield* fs.symlink(elsewhere, foreign);
      yield* fs.makeDirectory(path.dirname(otherLauncher), { recursive: true });
      yield* fs.symlink(otherHome, otherLauncher);

      for (const launchedAs of [copy, foreign, otherLauncher, undefined]) {
        const repointed = yield* repointLauncher({
          launchedAs,
          versionsDir: path.join(root, "runtime/versions"),
          targetEntryPath: newExe,
        });
        assert.equal(repointed._tag, "None", launchedAs ?? "undefined");
      }
      assert.equal(yield* fs.readLink(foreign), elsewhere);
      assert.equal(yield* fs.readLink(otherLauncher), otherHome);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("finds the launcher a bare command name resolved to on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const launcher = path.join(root, "bin/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.writeFileString(launcher, "");

      const bare = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, {
          PATH: `${path.join(root, "missing")}:${path.join(root, "bin")}`,
        }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const relative = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "./bin/t3"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );
      const absent = yield* resolveLauncherPath.pipe(
        Effect.provideService(HostProcess.InvokedAs, "t3"),
        Effect.provideService(HostProcess.Environment, { PATH: path.join(root, "missing") }),
        Effect.provideService(HostProcess.WorkingDirectory, root),
      );

      assert.equal(bare, launcher);
      assert.equal(relative, launcher);
      assert.equal(absent, undefined);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});
