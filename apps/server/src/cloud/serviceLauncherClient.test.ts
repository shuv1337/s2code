import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceLauncherChildMessage,
  type ServiceLauncherParentMessage,
} from "./serviceProtocol.ts";
import { posixLauncherScript, readPinnedRuntimeLaunchers } from "./pinnedRuntime.ts";
import { windowsForwarderShim } from "../cli/windowsForwarderShim.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";

class FakeLauncherProcess {
  readonly connected: boolean;
  readonly env: Record<string, string | undefined>;
  readonly sent: ServiceLauncherChildMessage[] = [];
  readonly #listeners = new Map<string, Set<(...args: ReadonlyArray<unknown>) => void>>();

  constructor(context: unknown, connected = true) {
    this.connected = connected;
    this.env = { [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify(context) };
  }

  send = (message: ServiceLauncherChildMessage, callback?: (error: Error | null) => void) => {
    this.sent.push(message);
    callback?.(null);
    return true;
  };

  on = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  };

  off = (event: "message" | "disconnect", listener: (...args: ReadonlyArray<unknown>) => void) => {
    this.#listeners.get(event)?.delete(listener);
  };

  emit(message: ServiceLauncherParentMessage) {
    for (const listener of this.#listeners.get("message") ?? []) listener(message);
  }
}

const makeClient = (host: FakeLauncherProcess, currentVersion: string) =>
  ServiceLauncherClient.make({ currentVersion }).pipe(
    Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
    Effect.provideService(HostProcess.Environment, host.env),
    Effect.provide(NodeServices.layer),
  );

// regression: #34502 a remote update never replaces the launcher, so an installed one stays protocol 3
it.effect.each([3, SERVICE_LAUNCHER_PROTOCOL])(
  "waits for a protocol-%i launcher to durably commit the trial update ID, then moves owned launchers",
  (protocol) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-trial-" });
      const baseDir = path.join(root, ".t3");
      const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
      const installed = path.join(root, ".local/bin/t3");
      for (const file of [exe("1.0.0"), exe("1.1.0")]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      yield* fs.makeDirectory(path.dirname(installed), { recursive: true });
      yield* fs.symlink(exe("1.0.0"), installed);

      const pending = {
        id: "update-1",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending" as const,
      };
      const host = new FakeLauncherProcess({ protocol, childVersion: "1.1.0", update: pending });
      host.env["HOME"] = root;
      // The launcher reloads the user manager after commit, so oomd's watch must already be mirrored.
      const bin = path.join(root, "bin");
      const calls = path.join(root, "systemctl-calls");
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(
        path.join(bin, "systemctl"),
        [
          "#!/bin/sh",
          `echo "$*" >>'${calls}'`,
          'case "$*" in',
          "  *ControlGroup*) echo /user.slice/user-1000.slice/user@1000.service ;;",
          "  *ManagedOOMMemoryPressureLimit*) echo 0 ;;",
          "  *ManagedOOMMemoryPressure\\ *) echo kill ;;",
          "esac",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(path.join(bin, "systemctl"), 0o755);
      host.env["PATH"] = `${bin}:/usr/bin:/bin`;
      const sentPrepared = yield* Deferred.make<void>();
      const send = host.send;
      host.send = (message, callback) => {
        Deferred.doneUnsafe(sentPrepared, Effect.void);
        return send(message, callback);
      };
      const client = yield* makeClient(host, "1.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      const prepared = yield* Effect.forkChild(client.prepareTrial({ baseDir }), {
        startImmediately: true,
      });
      yield* Deferred.await(sentPrepared);
      // Nothing runs systemctl after "prepared", so the log is what ran before it.
      expect(yield* fs.readFileString(calls)).toContain(
        "--user set-property --runtime -- -.slice ManagedOOMMemoryPressure=kill",
      );
      expect(host.sent).toEqual([{ type: "prepared", updateId: "update-1" }]);
      assert.equal(yield* fs.readLink(installed), exe("1.0.0"));

      const committed = {
        id: pending.id,
        fromVersion: pending.fromVersion,
        targetVersion: pending.targetVersion,
        status: "committed" as const,
      };
      host.emit({ type: "committed", updateId: committed.id });
      expect(yield* Fiber.join(prepared)).toEqual(committed);
      assert.equal(yield* fs.readFileString(installed), posixLauncherScript(exe("1.1.0")));

      // A later start replays the stored outcome; user pins made since then stay put.
      yield* fs.remove(installed);
      yield* fs.symlink(exe("1.0.0"), installed);
      const restarted = new FakeLauncherProcess({
        protocol,
        childVersion: "1.1.0",
        update: committed,
      });
      restarted.env["HOME"] = root;
      const restartedClient = yield* makeClient(restarted, "1.1.0");
      expect(yield* restartedClient.prepareTrial({ baseDir })).toEqual(committed);
      assert.equal(yield* fs.readLink(installed), exe("1.0.0"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns the launcher-generated ID only after update acceptance", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    });
    const client = yield* makeClient(host, "1.0.0");
    const requested = yield* Effect.forkChild(
      client.requestUpdate({ targetVersion: "1.1.0", dbPath: "/tmp/state.sqlite" }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    host.emit({
      type: "update-accepted",
      updateId: "launcher-id",
    });
    expect(yield* Fiber.join(requested)).toBe("launcher-id");
  }),
);

it.effect("preserves a launcher rejection as a distinct error", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    });
    const client = yield* makeClient(host, "1.0.0");
    const requested = yield* Effect.forkChild(
      client.requestUpdate({ targetVersion: "1.1.0", dbPath: "/tmp/state.sqlite" }),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;
    host.emit({ type: "update-rejected", reason: "requires local update" });
    expect(yield* Fiber.join(requested).pipe(Effect.flip)).toMatchObject({
      _tag: "ServiceLauncherRejectedError",
      targetVersion: "1.1.0",
      reason: "requires local update",
    });
  }),
);

it.effect("stops the server when the launcher asks over IPC", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.0.0",
    });
    const stopped = yield* Effect.forkChild(
      ServiceLauncherClient.awaitServiceLauncherStop({ currentVersion: "1.0.0" }).pipe(
        Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, host),
        Effect.provideService(HostProcess.Environment, host.env),
      ),
      { startImmediately: true },
    );
    host.emit({ type: "stop" });
    yield* Fiber.join(stopped);
  }),
);

it.effect("rejects contradictory trial context instead of leaving activation closed", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.1.0",
      update: {
        id: "update-1",
        fromVersion: "1.0.0",
        targetVersion: "1.2.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    });
    const error = yield* makeClient(host, "1.1.0").pipe(Effect.flip);
    expect(error.message).toBe("The service launcher supplied invalid startup context.");
  }),
);

it.effect("ignores launcher context inherited without an IPC channel", () =>
  Effect.gen(function* () {
    const host = new FakeLauncherProcess(
      { protocol: SERVICE_LAUNCHER_PROTOCOL, childVersion: "1.0.0" },
      false,
    );
    const client = yield* makeClient(host, "1.1.0");
    const error = yield* client
      .requestUpdate({ targetVersion: "1.2.0", dbPath: "/tmp/state.sqlite" })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "ServiceLauncherClientError", operation: "unmanaged" });
    expect(host.sent).toEqual([]);
  }),
);

it.layer(NodeServices.layer)("self-update launchers", (it) => {
  it.effect(
    "updates custom install and PATH launchers, including versions older than fromVersion",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
        const baseDir = path.join(root, ".t3");
        const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
        const installed = path.join(root, "custom/bin/t3");
        const onPath = path.join(root, "bin/t3");
        for (const file of [exe("1.0.0"), exe("1.5.0"), exe("2.0.0")]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "");
        }
        yield* fs.makeDirectory(path.dirname(installed), { recursive: true });
        yield* fs.writeFileString(installed, posixLauncherScript(exe("1.5.0")), { mode: 0o755 });
        yield* fs.makeDirectory(path.dirname(onPath), { recursive: true });
        yield* fs.symlink(exe("1.0.0"), onPath);

        yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            T3CODE_INSTALL_BIN_DIR: path.dirname(installed),
            PATH: path.dirname(onPath),
          }),
        );

        // The script is rewritten and the legacy symlink becomes one.
        assert.equal(yield* fs.readFileString(installed), posixLauncherScript(exe("2.0.0")));
        assert.equal(yield* fs.readFileString(onPath), posixLauncherScript(exe("2.0.0")));
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("still moves the PATH launcher when the install bin one cannot be rewritten", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const baseDir = path.join(root, ".t3");
      const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
      const installed = path.join(root, ".local/bin/t3");
      const onPath = path.join(root, "bin/t3");
      for (const file of [exe("1.0.0"), exe("2.0.0")]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      for (const link of [installed, onPath]) {
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.symlink(exe("1.0.0"), link);
      }
      const warnings: unknown[] = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(message);
      });
      const failingFs = FileSystem.FileSystem.of({
        ...fs,
        rename: (source, destination) =>
          destination === installed
            ? Effect.fail(
                new PlatformError.PlatformError(
                  new PlatformError.SystemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: destination,
                  }),
                ),
              )
            : fs.rename(source, destination),
      });

      yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: root,
          PATH: path.dirname(onPath),
        }),
        Effect.provideService(FileSystem.FileSystem, failingFs),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      );

      assert.lengthOf(warnings, 1);
      assert.include(JSON.stringify(warnings), installed);
      assert.equal(yield* fs.readLink(installed), exe("1.0.0"));
      assert.equal(yield* fs.readFileString(onPath), posixLauncherScript(exe("2.0.0")));
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("leaves unowned install files and PATH symlinks untouched after self-update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const baseDir = path.join(root, ".t3");
      const installed = path.join(root, ".local/bin/t3");
      const onPath = path.join(root, "bin/t3");
      const foreign = path.join(root, "other-home/runtime/versions/1.0.0/t3");
      const target = path.join(baseDir, "runtime/versions/2.0.0/t3");
      for (const file of [installed, foreign, target]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "user-owned file");
      }
      yield* fs.makeDirectory(path.dirname(onPath), { recursive: true });
      yield* fs.symlink(foreign, onPath);

      yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: root,
          PATH: path.dirname(onPath),
        }),
      );

      assert.equal(yield* fs.readFileString(installed), "user-owned file");
      assert.equal(yield* fs.readLink(onPath), foreign);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each([
    { name: "leading", searchPath: (missing: string) => `:${missing}`, moved: true },
    { name: "trailing", searchPath: (missing: string) => `${missing}:`, moved: true },
    { name: "whole", searchPath: () => "", moved: false },
  ])("treats a $name empty PATH entry like the shell does", ({ searchPath, moved }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const baseDir = path.join(root, ".t3");
      const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
      const cwd = path.join(root, "work");
      const inCwd = path.join(cwd, "t3");
      for (const file of [exe("1.0.0"), exe("2.0.0")]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "", { mode: 0o755 });
      }
      yield* fs.makeDirectory(cwd);
      yield* fs.symlink(exe("1.0.0"), inCwd);

      yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: root,
          PATH: searchPath(path.join(root, "missing")),
        }),
        Effect.provideService(HostProcess.WorkingDirectory, cwd),
      );

      // A nonempty PATH searches the working directory there; an empty PATH searches nothing.
      if (moved) {
        assert.equal(yield* fs.readFileString(inCwd), posixLauncherScript(exe("2.0.0")));
      } else {
        assert.equal(yield* fs.readLink(inCwd), exe("1.0.0"));
      }
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("passes over a working-directory t3 the shell cannot run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-" });
      const baseDir = path.join(root, ".t3");
      const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
      const cwd = path.join(root, "work");
      const onPath = path.join(root, "bin/t3");
      for (const file of [exe("1.0.0"), exe("2.0.0")]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "", { mode: 0o755 });
      }
      // A directory named t3 in the working directory, which the shell skips.
      yield* fs.makeDirectory(path.join(cwd, "t3"), { recursive: true });
      yield* fs.makeDirectory(path.dirname(onPath), { recursive: true });
      yield* fs.symlink(exe("1.0.0"), onPath);

      yield* ServiceLauncherClient.repointLaunchers({ baseDir, targetVersion: "2.0.0" }).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: root,
          PATH: `:${path.dirname(onPath)}`,
        }),
        Effect.provideService(HostProcess.WorkingDirectory, cwd),
      );

      assert.equal(yield* fs.readFileString(onPath), posixLauncherScript(exe("2.0.0")));
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  // regression: #478 background self-update must repoint 3-line <baseDir>/bin/shuv2code wrapper while preserving export S2CODE_HOME and ~/.local/bin symlinks
  it.effect(
    "repoints the 3-line legacy <baseDir>/bin/shuv2code wrapper, preserves S2CODE_HOME and ~/.local/bin symlinks, and adopts them into runtime/launchers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-issue478-" });
        const baseDir = path.join(root, ".shuv2code-v2-nightly");
        const oldVersion = "0.1.7-nightly.20261107.112";
        const newVersion = "0.1.11-nightly.20261122.145";
        const nextVersion = "0.1.11-nightly.20261123.146";
        const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
        for (const file of [exe(oldVersion), exe(newVersion), exe(nextVersion)]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "", { mode: 0o755 });
        }
        yield* fs.writeFileString(path.join(baseDir, "runtime/launchers"), "");
        const exportLine =
          'export S2CODE_HOME="${S2CODE_HOME:-${SHUV2CODE_HOME:-$HOME/.shuv2code-v2-nightly}}"';
        const legacyWrapper = [
          "#!/bin/sh",
          exportLine,
          `exec "$HOME/.shuv2code-v2-nightly/runtime/versions/${oldVersion}/t3" "$@"`,
          "",
        ].join("\n");
        const baseLauncher = path.join(baseDir, "bin/shuv2code");
        const customMultiLine = [
          "#!/bin/sh",
          'export PATH="/custom:$PATH"',
          `exec '${exe(oldVersion)}' "$@"`,
          "",
        ].join("\n");
        const customLauncher = path.join(baseDir, "bin/s2c");
        const customProfileWrapper = [
          "#!/bin/sh",
          'export S2CODE_HOME="/srv/another-profile"',
          `exec '${exe(oldVersion)}' "$@"`,
          "",
        ].join("\n");
        const customProfileLauncher = path.join(baseDir, "bin/t3");
        const localBin = path.join(root, ".local/bin");
        const legacyAlias = path.join(localBin, "shuv2code");
        const canonicalAlias = path.join(localBin, "s2code");
        yield* fs.makeDirectory(path.dirname(baseLauncher), { recursive: true });
        yield* fs.writeFileString(baseLauncher, legacyWrapper, { mode: 0o755 });
        yield* fs.writeFileString(customLauncher, customMultiLine, { mode: 0o755 });
        yield* fs.writeFileString(customProfileLauncher, customProfileWrapper, { mode: 0o755 });
        yield* fs.makeDirectory(localBin, { recursive: true });
        yield* fs.symlink(baseLauncher, legacyAlias);
        yield* fs.symlink(baseLauncher, canonicalAlias);

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: newVersion,
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            PATH: "",
          }),
        );

        assert.equal(
          yield* fs.readFileString(baseLauncher),
          posixLauncherScript(exe(newVersion), exportLine),
        );
        assert.equal(yield* fs.readFileString(customLauncher), customMultiLine);
        assert.equal(yield* fs.readFileString(customProfileLauncher), customProfileWrapper);
        assert.equal(yield* fs.readLink(legacyAlias), baseLauncher);
        assert.equal(yield* fs.readLink(canonicalAlias), baseLauncher);
        const recorded = yield* readPinnedRuntimeLaunchers(baseDir);
        assert.include(recorded, baseLauncher);
        assert.include(recorded, legacyAlias);
        assert.include(recorded, canonicalAlias);
        assert.notInclude(recorded, customLauncher);
        assert.notInclude(recorded, customProfileLauncher);

        // Subsequent self-update keeps the preserved export line and moves to the next version.
        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: nextVersion,
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            PATH: "",
          }),
        );
        assert.equal(
          yield* fs.readFileString(baseLauncher),
          posixLauncherScript(exe(nextVersion), exportLine),
        );
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "refuses launchers whose target inside runtime/versions resolves to a foreign home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-symlink-escape-" });
        const baseDir = path.join(root, ".s2code");
        const foreignBaseDir = path.join(root, ".other-s2code");
        const targetExe = path.join(baseDir, "runtime/versions/2.0.0/t3");
        const foreignDir = path.join(foreignBaseDir, "runtime/versions/1.0.0");
        const foreignExe = path.join(foreignDir, "t3");
        for (const file of [targetExe, foreignExe]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "", { mode: 0o755 });
        }
        // Symlinked version dir, symlinked version executable, and dangling foreign symlink under versions/.
        const escapedDir = path.join(baseDir, "runtime/versions/old");
        const escapedDirExe = path.join(escapedDir, "t3");
        yield* fs.symlink(foreignDir, escapedDir);
        const escapedFileDir = path.join(baseDir, "runtime/versions/old-file");
        const escapedFileExe = path.join(escapedFileDir, "t3");
        yield* fs.makeDirectory(escapedFileDir, { recursive: true });
        yield* fs.symlink(foreignExe, escapedFileExe);
        const danglingForeignDir = path.join(baseDir, "runtime/versions/old-dangling");
        const danglingForeignExe = path.join(danglingForeignDir, "t3");
        yield* fs.makeDirectory(danglingForeignDir, { recursive: true });
        yield* fs.symlink(
          path.join(foreignBaseDir, "runtime/versions/missing/t3"),
          danglingForeignExe,
        );
        // Symlink inside versions/ pointing to a missing file whose parent dir is symlinked to a foreign home.
        const danglingViaForeignParentDir = path.join(
          baseDir,
          "runtime/versions/old-dangling-parent",
        );
        const danglingViaForeignParentExe = path.join(danglingViaForeignParentDir, "t3");
        yield* fs.makeDirectory(danglingViaForeignParentDir, { recursive: true });
        yield* fs.symlink(path.join(escapedDir, "missing-t3"), danglingViaForeignParentExe);

        const localBin = path.join(root, ".local/bin");
        yield* fs.makeDirectory(localBin, { recursive: true });
        const linkToEscapedDir = path.join(localBin, "t3");
        const linkToEscapedFile = path.join(localBin, "s2c");
        const linkToDanglingForeign = path.join(localBin, "s2code");
        const linkToDanglingForeignParent = path.join(localBin, "shuv2code");
        const scriptToEscapedDir = path.join(baseDir, "bin/shuv2code");
        const scriptToDanglingForeign = path.join(baseDir, "bin/s2code");
        const scriptToDanglingForeignParent = path.join(baseDir, "bin/s2c");
        yield* fs.makeDirectory(path.dirname(scriptToEscapedDir), { recursive: true });
        yield* fs.symlink(escapedDirExe, linkToEscapedDir);
        yield* fs.symlink(escapedFileExe, linkToEscapedFile);
        yield* fs.symlink(danglingForeignExe, linkToDanglingForeign);
        yield* fs.symlink(danglingViaForeignParentExe, linkToDanglingForeignParent);
        const scriptBody = posixLauncherScript(escapedDirExe);
        const danglingScriptBody = posixLauncherScript(danglingForeignExe);
        const danglingParentScriptBody = posixLauncherScript(danglingViaForeignParentExe);
        yield* fs.writeFileString(scriptToEscapedDir, scriptBody, { mode: 0o755 });
        yield* fs.writeFileString(scriptToDanglingForeign, danglingScriptBody, { mode: 0o755 });
        yield* fs.writeFileString(scriptToDanglingForeignParent, danglingParentScriptBody, {
          mode: 0o755,
        });

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: "2.0.0",
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            PATH: localBin,
          }),
        );

        assert.equal(yield* fs.readLink(linkToEscapedDir), escapedDirExe);
        assert.equal(yield* fs.readLink(linkToEscapedFile), escapedFileExe);
        assert.equal(yield* fs.readLink(linkToDanglingForeign), danglingForeignExe);
        assert.equal(yield* fs.readLink(linkToDanglingForeignParent), danglingViaForeignParentExe);
        assert.equal(yield* fs.readFileString(scriptToEscapedDir), scriptBody);
        assert.equal(yield* fs.readFileString(scriptToDanglingForeign), danglingScriptBody);
        assert.equal(
          yield* fs.readFileString(scriptToDanglingForeignParent),
          danglingParentScriptBody,
        );
        assert.deepStrictEqual(yield* readPinnedRuntimeLaunchers(baseDir), []);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "refuses paths containing `..` after a symlink to a foreign directory (both direct candidates and dangling symlink targets)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-symlink-dotdot-" });
        const baseDir = path.join(root, ".s2code");
        const foreignBaseDir = path.join(root, ".other-s2code");
        const targetExe = path.join(baseDir, "runtime/versions/2.0.0/t3");
        const foreignSubdir = path.join(foreignBaseDir, "runtime/versions/1.0.0");
        yield* fs.makeDirectory(path.dirname(targetExe), { recursive: true });
        yield* fs.writeFileString(targetExe, "", { mode: 0o755 });
        yield* fs.makeDirectory(foreignSubdir, { recursive: true });

        // Symlink inside versions/ pointing to a foreign directory: `<versions>/escape/../missing-t3`
        // resolves via POSIX left-to-right semantics to `<foreignBaseDir>/runtime/versions/missing-t3`.
        const escapeLink = path.join(baseDir, "runtime/versions/escape");
        yield* fs.symlink(foreignSubdir, escapeLink);
        const dotDotViaForeign = `${escapeLink}/../missing-t3`;

        // Dangling symlink inside versions/ whose target uses `..` after `escape`.
        const danglingDotDotDir = path.join(baseDir, "runtime/versions/old-dotdot");
        const danglingDotDotExe = path.join(danglingDotDotDir, "t3");
        yield* fs.makeDirectory(danglingDotDotDir, { recursive: true });
        yield* fs.symlink(dotDotViaForeign, danglingDotDotExe);

        const localBin = path.join(root, ".local/bin");
        yield* fs.makeDirectory(localBin, { recursive: true });
        const linkDirectDotDot = path.join(localBin, "t3");
        const linkDanglingDotDot = path.join(localBin, "s2code");
        const scriptDirectDotDot = path.join(baseDir, "bin/shuv2code");
        const scriptDanglingDotDot = path.join(baseDir, "bin/s2c");
        yield* fs.makeDirectory(path.dirname(scriptDirectDotDot), { recursive: true });
        yield* fs.symlink(dotDotViaForeign, linkDirectDotDot);
        yield* fs.symlink(danglingDotDotExe, linkDanglingDotDot);
        const directScriptBody = posixLauncherScript(dotDotViaForeign);
        const danglingScriptBody = posixLauncherScript(danglingDotDotExe);
        yield* fs.writeFileString(scriptDirectDotDot, directScriptBody, { mode: 0o755 });
        yield* fs.writeFileString(scriptDanglingDotDot, danglingScriptBody, { mode: 0o755 });

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: "2.0.0",
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            PATH: localBin,
          }),
        );

        assert.equal(yield* fs.readLink(linkDirectDotDot), dotDotViaForeign);
        assert.equal(yield* fs.readLink(linkDanglingDotDot), danglingDotDotExe);
        assert.equal(yield* fs.readFileString(scriptDirectDotDot), directScriptBody);
        assert.equal(yield* fs.readFileString(scriptDanglingDotDot), danglingScriptBody);
        assert.deepStrictEqual(yield* readPinnedRuntimeLaunchers(baseDir), []);

        // Even when the lexically normalized path `<versions>/existing-t3` actually exists,
        // `<versions>/escape/../existing-t3` physically traverses to `<foreign>/runtime/versions/existing-t3`
        // and must NOT be treated as owned. Trailing slashes on regular files are also refused.
        const existingLocal = path.join(baseDir, "runtime/versions/existing-t3");
        const existingForeign = path.join(foreignBaseDir, "runtime/versions/existing-t3");
        yield* fs.writeFileString(existingLocal, "", { mode: 0o755 });
        yield* fs.writeFileString(existingForeign, "", { mode: 0o755 });
        const existingDotDotViaForeign = `${escapeLink}/../existing-t3`;
        const trailingSlashTarget = `${targetExe}/`;
        const scriptExistingDotDot = path.join(baseDir, "bin/s2code");
        const scriptTrailingSlash = path.join(baseDir, "bin/t3");
        const existingDotDotBody = posixLauncherScript(existingDotDotViaForeign);
        const trailingSlashBody = posixLauncherScript(trailingSlashTarget);
        yield* fs.writeFileString(scriptExistingDotDot, existingDotDotBody, { mode: 0o755 });
        yield* fs.writeFileString(scriptTrailingSlash, trailingSlashBody, { mode: 0o755 });

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: "2.0.0",
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            PATH: localBin,
          }),
        );

        assert.equal(yield* fs.readFileString(scriptExistingDotDot), existingDotDotBody);
        assert.equal(yield* fs.readFileString(scriptTrailingSlash), trailingSlashBody);
        assert.deepStrictEqual(yield* readPinnedRuntimeLaunchers(baseDir), []);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "rewrites an owned script whose target lexically matches target.entryPath but physically resolves to an older runtime",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-canonical-rewrite-" });
        const baseDir = path.join(root, ".s2code");
        const oldNested = path.join(baseDir, "runtime/versions/1.0.0/nested");
        const oldTarget = path.join(baseDir, "runtime/versions/1.0.0/2.0.0/t3");
        const newTarget = path.join(baseDir, "runtime/versions/2.0.0/t3");
        yield* fs.makeDirectory(oldNested, { recursive: true });
        for (const file of [oldTarget, newTarget]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "", { mode: 0o755 });
        }
        // `<versions>/old-link/../2.0.0/t3` lexically equals `<versions>/2.0.0/t3`,
        // but physically resolves through `old-link -> 1.0.0/nested` to `1.0.0/2.0.0/t3`.
        const oldLink = path.join(baseDir, "runtime/versions/old-link");
        yield* fs.symlink(oldNested, oldLink);
        const launcher = path.join(baseDir, "bin/shuv2code");
        yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
        yield* fs.writeFileString(launcher, posixLauncherScript(`${oldLink}/../2.0.0/t3`), {
          mode: 0o755,
        });

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: "2.0.0",
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            PATH: "",
          }),
        );

        assert.equal(yield* fs.readFileString(launcher), posixLauncherScript(newTarget));
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "repoints direct POSIX launcher scripts for s2code, shuv2code, s2c, t3, and recorded off-PATH launchers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-direct-scripts-" });
        const baseDir = path.join(root, ".s2code");
        const exe = (version: string) => path.join(baseDir, "runtime/versions", version, "t3");
        for (const file of [exe("1.0.0"), exe("2.0.0")]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "", { mode: 0o755 });
        }
        const installBin = path.join(root, "install-bin");
        const pathBinA = path.join(root, "path-a");
        const pathBinB = path.join(root, "path-b");
        const customBin = path.join(root, "custom-bin");
        for (const dir of [installBin, pathBinA, pathBinB, customBin]) {
          yield* fs.makeDirectory(dir, { recursive: true });
        }
        const launchers = [
          path.join(installBin, "s2code"),
          path.join(installBin, "shuv2code"),
          path.join(pathBinA, "s2c"),
          path.join(pathBinB, "t3"),
          path.join(customBin, "s2code-custom"),
        ];
        for (const launcher of launchers) {
          yield* fs.writeFileString(launcher, posixLauncherScript(exe("1.0.0")), { mode: 0o755 });
        }
        yield* fs.writeFileString(
          path.join(baseDir, "runtime/launchers"),
          `${path.join(customBin, "s2code-custom")}\n`,
        );

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: "2.0.0",
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            T3CODE_INSTALL_BIN_DIR: installBin,
            PATH: `${pathBinA}:${pathBinB}`,
          }),
        );

        const recorded = yield* readPinnedRuntimeLaunchers(baseDir);
        for (const launcher of launchers) {
          assert.equal(yield* fs.readFileString(launcher), posixLauncherScript(exe("2.0.0")));
          assert.include(recorded, launcher);
        }
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "leaves foreign-home scripts, foreign symlink chains, and custom user scripts untouched",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-foreign-safety-" });
        const baseDir = path.join(root, ".s2code");
        const otherBaseDir = path.join(root, ".other-s2code");
        const targetExe = path.join(baseDir, "runtime/versions/2.0.0/t3");
        const otherExe = path.join(otherBaseDir, "runtime/versions/1.0.0/t3");
        for (const file of [targetExe, otherExe]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "", { mode: 0o755 });
        }
        const otherBaseLauncher = path.join(otherBaseDir, "bin/shuv2code");
        yield* fs.makeDirectory(path.dirname(otherBaseLauncher), { recursive: true });
        yield* fs.writeFileString(otherBaseLauncher, posixLauncherScript(otherExe), {
          mode: 0o755,
        });

        const localBin = path.join(root, ".local/bin");
        yield* fs.makeDirectory(localBin, { recursive: true });
        const foreignSymlink = path.join(localBin, "s2code");
        const customScript = path.join(localBin, "shuv2code");
        const foreignDirect = path.join(localBin, "s2c");
        const loopLink = path.join(localBin, "t3");
        yield* fs.symlink(otherBaseLauncher, foreignSymlink);
        yield* fs.writeFileString(customScript, "#!/bin/sh\necho mine\n", { mode: 0o755 });
        yield* fs.writeFileString(foreignDirect, posixLauncherScript(otherExe), { mode: 0o755 });
        yield* fs.symlink(loopLink, loopLink);

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: "2.0.0",
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            HOME: root,
            PATH: localBin,
          }),
        );

        assert.equal(yield* fs.readLink(foreignSymlink), otherBaseLauncher);
        assert.equal(yield* fs.readFileString(otherBaseLauncher), posixLauncherScript(otherExe));
        assert.equal(yield* fs.readFileString(customScript), "#!/bin/sh\necho mine\n");
        assert.equal(yield* fs.readFileString(foreignDirect), posixLauncherScript(otherExe));
        assert.equal(yield* fs.readLink(loopLink), loopLink);
        assert.deepStrictEqual(yield* readPinnedRuntimeLaunchers(baseDir), []);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "repoints owned Windows .cmd shims and forwarders while leaving foreign shims alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win-shims-" });
        const baseDir = path.join(root, ".s2code-nightly");
        const oldVersion = "0.1.11-nightly.20261121.143";
        const newVersion = "0.1.11-nightly.20261122.145";
        const oldExe = path.join(baseDir, "runtime/versions", oldVersion, "t3.exe");
        const newExe = path.join(baseDir, "runtime/versions", newVersion, "t3.exe");
        const foreignExe = path.join(root, "other-home/runtime/versions/1.0.0/t3.exe");
        for (const file of [oldExe, newExe, foreignExe]) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "");
        }

        const baseBin = path.join(baseDir, "bin");
        const installBin = path.join(root, "install-bin");
        const pathBin = path.join(root, "path-bin");
        const recordedDir = path.join(root, "recorded-bin");
        for (const dir of [baseBin, installBin, pathBin, recordedDir]) {
          yield* fs.makeDirectory(dir, { recursive: true });
        }

        const baseShim = path.join(baseBin, "shuv2code.cmd");
        const directShim = path.join(installBin, "s2c.cmd");
        const legacyTarget = path.join(pathBin, "shuv2code-nightly.cmd");
        const forwarderShim = path.join(pathBin, "s2code-nightly.cmd");
        const recordedShim = path.join(recordedDir, "custom-s2code.cmd");
        const foreignHomeShim = path.join(installBin, "t3.cmd");
        const customUserShim = path.join(pathBin, "s2code.cmd");

        const oldBody = `@echo off\r\n"${oldExe}" %*`;
        const newBody = `@echo off\r\n"${newExe}" %*`;
        const forwarderBody = windowsForwarderShim(legacyTarget);
        const foreignHomeBody = `@echo off\r\n"${foreignExe}" %*`;
        const customUserBody = "@echo off\r\necho mine\r\n";

        yield* fs.writeFileString(baseShim, oldBody);
        yield* fs.writeFileString(directShim, oldBody);
        yield* fs.writeFileString(legacyTarget, oldBody);
        yield* fs.writeFileString(forwarderShim, forwarderBody);
        yield* fs.writeFileString(recordedShim, oldBody);
        yield* fs.writeFileString(foreignHomeShim, foreignHomeBody);
        yield* fs.writeFileString(customUserShim, customUserBody);
        yield* fs.writeFileString(path.join(baseDir, "runtime/launchers"), `${recordedShim}\r\n`);

        yield* ServiceLauncherClient.repointLaunchers({
          baseDir,
          targetVersion: newVersion,
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            USERPROFILE: root,
            T3CODE_INSTALL_BIN_DIR: installBin,
            PATH: `${pathBin};`,
          }),
        );

        assert.equal(yield* fs.readFileString(baseShim), newBody);
        assert.equal(yield* fs.readFileString(directShim), newBody);
        assert.equal(yield* fs.readFileString(legacyTarget), newBody);
        assert.equal(yield* fs.readFileString(forwarderShim), forwarderBody);
        assert.equal(yield* fs.readFileString(recordedShim), newBody);
        assert.equal(yield* fs.readFileString(foreignHomeShim), foreignHomeBody);
        assert.equal(yield* fs.readFileString(customUserShim), customUserBody);

        const recorded = yield* readPinnedRuntimeLaunchers(baseDir);
        assert.include(recorded, baseShim);
        assert.include(recorded, directShim);
        assert.include(recorded, legacyTarget);
        assert.include(recorded, forwarderShim);
        assert.include(recorded, recordedShim);
        assert.notInclude(recorded, foreignHomeShim);
        assert.notInclude(recorded, customUserShim);
      }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
});
