import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ManagedUpdatesPolicy } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { afterEach, vi } from "vite-plus/test";
import * as BootService from "../cloud/bootService.ts";
import * as ProcessRunner from "../processRunner.ts";

import { prunePinnedRuntimes } from "../cloud/pinnedRuntime.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  repointLauncher,
  resolveLauncherPath,
  resolveNewestVersion,
  runUpdate,
  isForkBootServiceCgroup,
  formatUpdatedLauncherCommand,
  readLauncherTarget,
} from "./update.ts";
import { windowsForwarderShim } from "./windowsForwarderShim.ts";

// lsof listing one process, so prune sees a process list in which no runtime is running.
const unrelatedLsof = ProcessRunner.ProcessRunner.of({
  run: () =>
    Effect.succeed({
      stdout: "p1\nftxt\nn/usr/bin/true\n",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});

afterEach(() => vi.restoreAllMocks());

it("recognizes only exact fork boot service cgroup components", () => {
  for (const unit of ["s2code-v2", "s2code-v2-nightly", "s2code-v2-preview"]) {
    assert.isTrue(isForkBootServiceCgroup(`0::/user.slice/${unit}.service\n`));
    assert.isTrue(isForkBootServiceCgroup(`0::/user.slice/${unit}.service/child`));
  }
  for (const unit of ["t3code.service", "s2code-v2.service-other", "not-s2code-v2.service"])
    assert.isFalse(isForkBootServiceCgroup(`0::/user.slice/${unit}`));
});
it.effect("authenticates each release page until the requested channel is found", () =>
  Effect.gen(function* () {
    const pages: string[] = [];
    const httpClient = HttpClient.make((request) => {
      const url = new URL(request.url);
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.pathname, "/repos/shuv1337/s2code/releases");
      assert.equal(request.headers.accept, "application/vnd.github+json");
      assert.equal(request.headers.authorization, "Bearer gh-token");
      const page = url.searchParams.get("page") ?? "";
      pages.push(page);
      const tag_name = page === "1" ? "v1.2.4-preview.20260101.1" : "v1.2.3";
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([{ tag_name }])));
    });
    const version = yield* resolveNewestVersion("stable").pipe(
      Effect.provideService(HostProcess.Environment, { GH_TOKEN: "gh-token" }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    assert.equal(version, "1.2.3");
    assert.deepStrictEqual(pages, ["1", "2"]);
  }),
);

it.layer(NodeServices.layer)("t3 update under a managed policy", (it) => {
  const runWithPolicy = (
    updates: ManagedUpdatesPolicy,
    input: { readonly channel?: "stable" | "nightly"; readonly requestedVersion?: string } = {},
  ) =>
    runUpdate({
      baseDir: "/unused",
      logsDir: "/unused",
      serverRuntimeStatePath: "/unused",
      channel: input.channel,
      requestedVersion: input.requestedVersion,
      allowDowngrade: false,
      assumeYes: true,
    }).pipe(
      Effect.flip,
      Effect.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { updates },
          }),
          // Refusals happen before the update touches the network, the service, or a process.
          Layer.mock(BootService.BootService, {}),
          Layer.mock(ProcessRunner.ProcessRunner, {}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected release lookup")),
          ),
        ),
      ),
    );

  it.effect("refuses to update when updates are off", () =>
    Effect.gen(function* () {
      const error = yield* runWithPolicy({ mode: "off" });
      assert.equal(error.message, "Example Corp manages T3 Code updates.");
    }),
  );

  it.effect("refuses nightly releases when the policy disallows them", () =>
    Effect.gen(function* () {
      const byChannel = yield* runWithPolicy(
        { mode: "auto", allowNightly: false },
        { channel: "nightly" },
      );
      const byVersion = yield* runWithPolicy(
        { mode: "auto", allowNightly: false },
        { channel: "stable", requestedVersion: "1.2.0-nightly.20261028.1" },
      );
      for (const error of [byChannel, byVersion]) {
        assert.equal(
          error.message,
          "Example Corp manages T3 Code updates. Only stable releases can be installed.",
        );
      }
    }),
  );
});

it.layer(NodeServices.layer)("t3 update launcher", (it) => {
  it.effect.each(["linux", "win32"] as const)(
    "updates same-home direct aliases and preserves the old-updater bridge on %s",
    (platform) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "s2code-alias-update-" });
        const versionsDir = path.join(root, "runtime", "versions");
        const oldExe = path.join(versionsDir, "1.0.0-nightly.1", "t3");
        const newExe = path.join(versionsDir, "1.0.0-nightly.2", "t3");
        const foreignExe = path.join(root, "other", "runtime", "versions", "1.0.0", "t3");
        const bin = path.join(root, "bin");
        yield* fs.makeDirectory(bin);
        for (const executable of [oldExe, newExe, foreignExe]) {
          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "");
        }
        const suffix = platform === "win32" ? ".cmd" : "";
        const canonical = path.join(bin, `s2code-nightly${suffix}`);
        const legacy = path.join(bin, `shuv2code-nightly${suffix}`);
        const foreignAlias = path.join(bin, `s2c${suffix}`);
        const stable = path.join(bin, `s2code${suffix}`);
        const write = (file: string, target: string) =>
          platform === "win32"
            ? fs.writeFileString(file, `@echo off\r\n"${target}" %*`)
            : fs.symlink(target, file);
        yield* write(legacy, oldExe);
        if (platform === "win32") {
          yield* fs.writeFileString(canonical, `@echo off\r\n"${legacy}" %*`);
        } else {
          yield* write(canonical, legacy);
        }
        yield* write(foreignAlias, foreignExe);
        yield* write(stable, oldExe);
        const update = repointLauncher({
          launchedAs: platform === "win32" ? oldExe : canonical,
          currentVersion: "1.0.0-nightly.1",
          baseDir: root,
          targetEntryPath: newExe,
        }).pipe(Effect.provideService(HostProcess.Environment, { PATH: bin }));
        assert.equal(Option.getOrUndefined(yield* update), canonical);
        assert.deepEqual(yield* readLauncherTarget(canonical, "1.0.0-nightly.1"), {
          target: newExe,
          forwarder: true,
        });
        assert.equal((yield* readLauncherTarget(legacy, "1.0.0-nightly.1"))?.target, newExe);
        assert.equal((yield* readLauncherTarget(foreignAlias))?.target, foreignExe);
        assert.equal((yield* readLauncherTarget(stable))?.target, oldExe);
        if (platform === "win32") {
          assert.equal(yield* fs.readFileString(canonical), windowsForwarderShim(legacy));
        }
        yield* fs.remove(canonical);
        yield* fs.remove(legacy);
        yield* write(canonical, oldExe);
        yield* write(legacy, oldExe);
        yield* update;
        assert.equal((yield* readLauncherTarget(canonical, "1.0.0-nightly.1"))?.target, newExe);
        assert.equal((yield* readLauncherTarget(legacy, "1.0.0-nightly.1"))?.target, newExe);
        if (platform === "win32") {
          assert.equal(yield* fs.readFileString(canonical), `@echo off\r\n"${newExe}" %*`);
          assert.equal(yield* fs.readFileString(legacy), `@echo off\r\n"${newExe}" %*`);
        }
      }).pipe(Effect.provideService(HostProcess.Platform, platform), Effect.scoped),
  );

  it.effect("upgrades a Windows forwarder whose bin path contains a space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "s2code-shim-parse-" });
      const bin = path.join(root, "Program Files (x86)", "installer bin");
      const version = "1.0.0-nightly.1";
      const versionsDir = path.join(root, "runtime", "versions");
      const oldExe = path.join(versionsDir, version, "t3.exe");
      const newExe = path.join(versionsDir, "1.0.0-nightly.2", "t3.exe");
      for (const executable of [oldExe, newExe]) {
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "");
      }
      const legacy = path.join(bin, "shuv2code-nightly.cmd");
      const canonical = path.join(bin, "s2code-nightly.cmd");
      yield* fs.makeDirectory(bin, { recursive: true });
      const repaired = windowsForwarderShim(legacy);
      assert.isFalse(repaired.includes("call "));
      assert.isFalse(repaired.endsWith("\n"));
      const repoint = (launchedAs: string) =>
        repointLauncher({
          launchedAs,
          currentVersion: version,
          baseDir: root,
          targetEntryPath: newExe,
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            PATH: bin,
            T3CODE_INSTALL_BIN_DIR: bin,
          }),
        );
      for (const previous of [`@echo off\r\n"${legacy}" %*`, `@echo off\r\ncall "${legacy}" %*`]) {
        yield* fs.writeFileString(legacy, `@echo off\r\n"${oldExe}" %*`);
        yield* fs.writeFileString(canonical, previous);
        assert.deepEqual(yield* readLauncherTarget(canonical, version), {
          target: oldExe,
          forwarder: true,
        });
        assert.equal(Option.getOrUndefined(yield* repoint(oldExe)), canonical);
        assert.equal(yield* fs.readFileString(canonical), repaired);
        assert.equal(yield* fs.readFileString(legacy), `@echo off\r\n"${newExe}" %*`);
        assert.deepEqual(yield* readLauncherTarget(canonical, version), {
          target: newExe,
          forwarder: true,
        });
        assert.equal(Option.getOrUndefined(yield* repoint(newExe)), canonical);
        assert.equal(yield* fs.readFileString(canonical), repaired);
        assert.equal(yield* fs.readFileString(legacy), `@echo off\r\n"${newExe}" %*`);
      }
    }).pipe(Effect.provideService(HostProcess.Platform, "win32"), Effect.scoped),
  );
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
              Effect.provide(ManagedPolicy.layerTest()),
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
      const stableShim = path.join(bin, "s2code.cmd");
      const shim = path.join(bin, `s2code-${channel}.cmd`);
      yield* fs.writeFileString(stableShim, content);
      yield* fs.writeFileString(shim, content);
      const repointed = yield* repointLauncher({
        currentVersion: version,
        launchedAs: oldExe,
        baseDir: root,
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
        baseDir: root,
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
        baseDir: root,
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

  it.effect.each([
    { name: "no launcher records", recorded: undefined },
    { name: "an empty launcher record", recorded: "" },
    { name: "whole launcher records", recorded: "/opt/t3\n" },
    { name: "Windows launcher records", recorded: "C:\\t3.cmd\r\n" },
    // An interrupted append cut this record short.
    { name: "an unterminated launcher record", recorded: "/opt/t" },
    // Another process's append is cut short after t3 update reads the records.
    { name: "a record cut short after the read", recorded: "/opt/t3\n", cut: "/opt/t" },
  ])("keeps the runtime a repointed launcher off PATH points at with $name", ({ recorded, cut }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      yield* TestClock.setTime(Duration.toMillis(Duration.days(1)));
      for (const version of ["1.0.0", "2.0.0"]) {
        const directory = path.join(root, "runtime/versions", version);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "t3"), "");
        yield* fs.writeFileString(path.join(directory, ".install-complete"), `${version}\n`);
        yield* fs.utimes(path.join(directory, ".install-complete"), 0, 0);
      }
      if (recorded !== undefined) {
        yield* fs.writeFileString(path.join(root, "runtime/launchers"), recorded);
      }
      // A launcher in the T3 home itself, which neither PATH nor the default bin dir reaches.
      const launcher = path.join(root, "t3");
      yield* fs.symlink(path.join(root, "runtime/versions/1.0.0/t3"), launcher);

      const launchersFile = path.join(root, "runtime/launchers");
      yield* repointLauncher({
        launchedAs: launcher,
        baseDir: root,
        targetEntryPath: path.join(root, "runtime/versions/2.0.0/t3"),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (file, encoding) =>
            fs
              .readFileString(file, encoding)
              .pipe(
                Effect.tap(() =>
                  cut === undefined || file !== launchersFile
                    ? Effect.void
                    : fs.writeFileString(file, cut, { flag: "a" }),
                ),
              ),
        }),
      );
      // A later server start prunes with no idea how this machine launches t3.
      const removed = yield* prunePinnedRuntimes({ baseDir: root, keep: [] }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, unrelatedLsof),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
        Effect.provideService(HostProcess.HomeDirectory, root),
      );

      assert.deepStrictEqual(removed, ["1.0.0"]);
      // macOS temp dirs sit behind the /var -> /private/var symlink, so compare canonical paths.
      assert.equal(
        yield* fs.realPath(launcher),
        yield* fs.realPath(path.join(root, "runtime/versions/2.0.0/t3")),
      );
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  const launcherFixture = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
    const oldExe = path.join(root, "runtime/versions/1.0.0/t3");
    const newExe = path.join(root, "runtime/versions/2.0.0/t3");
    const launcher = path.join(root, "t3");
    for (const file of [oldExe, newExe]) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, "");
    }
    yield* fs.symlink(oldExe, launcher);
    return { root, oldExe, newExe, launcher, launchersFile: path.join(root, "runtime/launchers") };
  });

  it.effect("records a relative launcher path as absolute", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, newExe, launcher, launchersFile } = yield* launcherFixture();

      yield* repointLauncher({
        launchedAs: path.relative(path.resolve("."), launcher),
        baseDir: root,
        targetEntryPath: newExe,
      });

      assert.equal(yield* fs.readFileString(launchersFile), `\n${launcher}\n`);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("fails instead of repointing a launcher it cannot record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, oldExe, newExe, launcher, launchersFile } = yield* launcherFixture();
      // Appending to a directory fails the way a read-only or full disk would.
      yield* fs.makeDirectory(launchersFile);

      const result = yield* repointLauncher({
        launchedAs: launcher,
        baseDir: root,
        targetEntryPath: newExe,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(result));
      assert.equal(yield* fs.readLink(launcher), oldExe);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["recording", "repointing"] as const)(
    "never leaves a repointed launcher unrecorded when t3 update dies while %s",
    (step) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, newExe, launcher, launchersFile } = yield* launcherFixture();

        yield* repointLauncher({
          launchedAs: launcher,
          baseDir: root,
          targetEntryPath: newExe,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (path, data, options) =>
              step === "recording" && path === launchersFile
                ? Effect.die("t3 update was killed")
                : fs.writeFileString(path, data, options),
            rename: (from, to) =>
              step === "repointing" && to === launcher
                ? Effect.die("t3 update was killed")
                : fs.rename(from, to),
          }),
          Effect.exit,
        );

        const repointed = (yield* fs.readLink(launcher)) === newExe;
        const recorded = (yield* fs
          .readFileString(launchersFile)
          .pipe(Effect.orElseSucceed(() => "")))
          .split("\n")
          .includes(launcher);
        assert.isFalse(repointed && !recorded);
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
          baseDir: root,
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
