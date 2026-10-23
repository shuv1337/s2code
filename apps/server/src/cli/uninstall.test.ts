import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as BootService from "../cloud/bootService.ts";

import { findOwnedLauncher, runUninstall } from "./uninstall.ts";

it.layer(NodeServices.layer)("t3 uninstall launcher", (it) => {
  it.effect("claims only a launcher that points into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t3");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t3");
      const copy = path.join(root, "copy/t3");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/shuv2code");
      const theirs = path.join(root, "other/bin/t3");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.equal(
        yield* findOwnedLauncher({ launchedAs: ours, versionsDir, version: "1.0.0" }),
        ours,
      );
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: theirs, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: copy, versionsDir }));
      assert.isUndefined(yield* findOwnedLauncher({ launchedAs: undefined, versionsDir }));
      const upstreamName = path.join(root, "bin/t3");
      yield* fs.symlink(exe, upstreamName);
      assert.isUndefined(
        yield* findOwnedLauncher({ launchedAs: upstreamName, versionsDir, version: "1.0.0" }),
      );
      for (const name of ["s2code", "s2c", "shuv2code"]) {
        const launcher = path.join(root, "aliases", name);
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.symlink(exe, launcher);
        assert.equal(
          yield* findOwnedLauncher({ launchedAs: launcher, versionsDir, version: "1.0.0" }),
          launcher,
        );
      }
      for (const name of ["s2code-nightly", "shuv2code-preview"]) {
        const launcher = path.join(root, "aliases", name);
        yield* fs.symlink(exe, launcher);
        assert.isUndefined(
          yield* findOwnedLauncher({ launchedAs: launcher, versionsDir, version: "1.0.0" }),
        );
      }
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
  it.effect(
    "removes the legacy service and both launcher spellings while keeping foreign aliases",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const baseDir = path.join(root, "fork");
        const executable = path.join(baseDir, "runtime/versions/1.0.0/t3");
        const foreignExecutable = path.join(root, "other/runtime/versions/1.0.0/t3");
        const unit = path.join(root, ".config/systemd/user/shuv2code-v2.service");
        const sentinel = path.join(baseDir, "userdata/statev2.sqlite");
        for (const file of [executable, foreignExecutable, unit, sentinel]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "sentinel");
        }
        const bin = path.join(root, "bin");
        yield* fs.makeDirectory(bin);
        yield* fs.symlink(executable, path.join(bin, "shuv2code"));
        yield* fs.symlink(path.join(bin, "shuv2code"), path.join(bin, "s2code"));
        yield* fs.symlink(foreignExecutable, path.join(bin, "s2c"));
        yield* fs.symlink(executable, path.join(bin, "s2code-nightly"));
        let removals = 0;
        const service = BootService.BootService.of({
          status: Effect.succeed({
            supported: true,
            installed: true,
            current: true,
            unitPath: unit,
            installedBaseDir: baseDir,
            logPath: path.join(root, "service.log"),
          }),
          install: () => Effect.die("not invoked"),
          withStopped: () => Effect.die("not invoked"),
          restart: Effect.succeed(false),
          uninstall: Effect.gen(function* () {
            assert.equal(yield* fs.exists(executable).pipe(Effect.orDie), true);
            removals++;
            return true;
          }),
        });
        yield* runUninstall({ baseDir, assumeYes: true }).pipe(
          Effect.provideService(BootService.BootService, service),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.InvokedAs, path.join(bin, "shuv2code")),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        assert.equal(removals, 1);
        assert.equal(yield* fs.exists(path.join(bin, "s2code")), false);
        assert.equal(yield* fs.exists(path.join(bin, "shuv2code")), false);
        assert.equal(yield* fs.readLink(path.join(bin, "s2c")), foreignExecutable);
        assert.equal(yield* fs.readLink(path.join(bin, "s2code-nightly")), executable);
        assert.equal(yield* fs.readFileString(sentinel), "sentinel");
        assert.equal(yield* fs.readFileString(foreignExecutable), "sentinel");
      }),
  );
  it.effect(
    "leaves upstream launchers and services untouched even when an upstream unit names this home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const baseDir = path.join(root, "fork");
        const upstream = path.join(root, "upstream");
        const executable = path.join(upstream, "runtime/versions/1.0.0/t3");
        const launcher = path.join(root, "bin/t3");
        const unit = path.join(root, ".config/systemd/user/t3code.service");
        for (const file of [executable, unit]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "upstream-sentinel");
        }
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.symlink(executable, launcher);
        let removals = 0;
        const service = BootService.BootService.of({
          status: Effect.succeed({
            supported: true,
            installed: true,
            current: true,
            unitPath: unit,
            installedBaseDir: baseDir,
            logPath: path.join(root, "upstream.log"),
          }),
          install: () => Effect.die("not invoked"),
          withStopped: () => Effect.die("not invoked"),
          restart: Effect.succeed(false),
          uninstall: Effect.sync(() => {
            removals++;
            return true;
          }),
        });
        const messages: string[] = [];
        yield* runUninstall({ baseDir, assumeYes: true }).pipe(
          Effect.provideService(BootService.BootService, service),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.InvokedAs, launcher),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(Console.Console, {
            ...globalThis.console,
            log: (...args) => {
              messages.push(args.join(" "));
            },
          }),
        );
        assert.equal(removals, 0);
        assert.equal(yield* fs.readLink(launcher), executable);
        assert.equal(yield* fs.readFileString(executable), "upstream-sentinel");
        assert.equal(yield* fs.readFileString(unit), "upstream-sentinel");
        assert.notMatch(messages.join("\n"), /npm uninstall[^`]*\bt3\b/);
      }),
  );
});
