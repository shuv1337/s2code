import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

describe("ssh tunnel scripts", () => {
  it.each(["stable", "nightly", "preview"])(
    "keeps automatic %s runtime, pairing and lifecycle bookkeeping in its channel home",
    (channel) => {
      const input = {
        archiveVersion: channel === "stable" ? "1.2.3" : `1.2.3-${channel}.20261014.1`,
      };
      const home = `.s2code-v2${channel === "stable" ? "" : `-${channel}`}`;
      const runner = SshTunnel.buildRemoteT3RunnerScript(input);
      const launch = SshTunnel.buildRemoteLaunchScript(input);
      const pairing = SshTunnel.buildRemotePairingScript("fixture", input);
      const stop = SshTunnel.buildRemoteStopScript("fixture", input);
      assert.include(runner, `T3_PRODUCT_HOME="$HOME/${home}"`);
      assert.include(runner, "$T3_PRODUCT_HOME/runtime/versions");
      for (const script of [launch, pairing, stop]) {
        assert.include(script, `T3_PRODUCT_HOME="$HOME/${home}"`);
        assert.include(script, "$T3_PRODUCT_HOME/ssh-launch/");
        assert.notInclude(script, "@@T3_HOME_DIRECTORY@@");
        if (channel !== "stable") assert.notInclude(script, "$HOME/.s2code-v2/");
      }
      assert.include(launch, 'DEFAULT_SERVER_HOME="$T3_PRODUCT_HOME"');
      assert.include(pairing, 'DEFAULT_SERVER_HOME="$T3_PRODUCT_HOME"');
      assert.include(launch, '--base-dir "$DEFAULT_SERVER_HOME"');
      assert.include(stop, '[ "$REMOTE_MANAGED" != "external" ]');
    },
  );

  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/shuv1337/s2code/releases/download'",
    );
    assert.include(
      script,
      'T3_RUNTIME_DIR="$T3_PRODUCT_HOME/runtime/versions/$T3_ARCHIVE_VERSION"',
    );
    assert.include(script, 'T3_ARCHIVE="s2code-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
    assert.include(
      script,
      'T3_LEGACY_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"',
    );
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/t3" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    assert.include(
      script,
      'T3_LOCK="$T3_PRODUCT_HOME/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    assert.include(script, 'if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then');
    assert.include(script, 'if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then');
    assert.include(script, 'if [ "$T3_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$T3_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$T3_STAGING/$T3_ARCHIVE" 240');
    assert.notInclude(script, "T3_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$T3_STAGING/t3" --version'),
      script.indexOf('> "$T3_STAGING/.install-complete"'),
    );
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("T3_ARCHIVE_VERSION="),
    );

    const launch = SshTunnel.buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/t3/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
    assert.include(SshTunnel.buildRemoteLaunchScript(NODE_SCRIPT), "T3_ARCHIVE_MODE=0");
  });

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

describe("archive runner script", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const hostArch = HostProcess.Architecture.defaultValue();
  const windowsHost = hostPlatform === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runRunner = (home: string, runner: string, path = process.env.PATH ?? "") =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("sh", [runner, "--version"], {
          env: { PATH: path, HOME: home },
          extendEnv: false,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });

  // A fake "executable" that answers --version, packed the way the release
  // workflow packs the real archive: one top-level directory named after the
  // stem, checksummed in SHA256SUMS.
  const makeMirror = Effect.fn("makeMirror")(function* (
    root: string,
    version = archiveVersion,
    legacy = false,
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `${legacy ? "t3" : "s2code"}-${version}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const release = `${root}/mirror/v${version}`;
    const channelHome = version.includes("-nightly.") ? ".s2code-v2-nightly" : ".s2code-v2-preview";
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${release}'`,
      `printf '#!/bin/sh\\ntest "$(cat "$HOME/${channelHome}/.product-identity")" = s2code || exit 91\\necho t3 v${version}\\n' > '${stage}/t3'`,
      `chmod +x '${stage}/t3'`,
      `tar -czf '${release}/${stem}.tar.gz' -C '${root}/stage' '${stem}'`,
      `cd '${release}' && (sha256sum '${stem}.tar.gz' 2>/dev/null || shasum -a 256 '${stem}.tar.gz') > SHA256SUMS`,
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  it.effect.skipIf(windowsHost)("reuses a legacy owned remote cache and rejects ambiguity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "s2code-ssh-upgrade-" });
      const home = `${root}/home`;
      const legacy = `${home}/.shuv2code-v2-preview`;
      const current = `${home}/.s2code-v2-preview`;
      const runtime = `${legacy}/runtime/versions/${archiveVersion}`;
      yield* fs.makeDirectory(runtime, { recursive: true });
      yield* fs.writeFileString(`${legacy}/.product-identity`, "shuv2code\n");
      yield* fs.writeFileString(`${runtime}/.install-product`, "shuv2code\n");
      yield* fs.writeFileString(`${runtime}/.install-complete`, `${archiveVersion}\n`);
      yield* fs.writeFileString(
        `${runtime}/t3`,
        '#!/bin/sh\nprintf "%s\\n" "$S2CODE_HOME" "$SHUV2CODE_HOME"\n',
        { mode: 0o755 },
      );
      const runner = `${root}/run.sh`;
      yield* fs.writeFileString(
        runner,
        SshTunnel.buildRemoteT3RunnerScript({
          archiveVersion,
          releaseBaseUrl: `file://${root}/missing`,
        }),
      );
      const old = yield* runRunner(home, runner);
      assert.equal(old.exitCode, 0, old.stderr);
      assert.equal(old.stdout, `${legacy}\n${legacy}\n`);
      assert.isFalse(yield* fs.exists(current));
      assert.equal(yield* fs.readFileString(`${legacy}/.product-identity`), "shuv2code\n");
      yield* fs.makeDirectory(current);
      yield* fs.writeFileString(`${current}/settings.json`, "other environment");
      const ambiguous = yield* runRunner(home, runner);
      assert.notEqual(ambiguous.exitCode, 0);
      assert.include(ambiguous.stderr, "Both s2code and shuv2code homes contain state");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)(
    "reopens the pre-marker stable home without choosing new state",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "s2code-ssh-pre-marker-" });
        const home = `${root}/home`;
        const legacy = `${home}/.shuv2code-v2`;
        const runtime = `${legacy}/runtime/versions/1.2.3`;
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.writeFileString(`${runtime}/.install-product`, "shuv2code\n");
        yield* fs.writeFileString(`${runtime}/.install-complete`, "1.2.3\n");
        yield* fs.writeFileString(`${runtime}/t3`, '#!/bin/sh\nprintf "%s\\n" "$S2CODE_HOME"\n', {
          mode: 0o755,
        });
        const runner = `${root}/run.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({
            archiveVersion: "1.2.3",
            releaseBaseUrl: `file://${root}/missing`,
          }),
        );
        const result = yield* runRunner(home, runner);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout, `${legacy}\n`);
        assert.equal(yield* fs.readFileString(`${legacy}/.product-identity`), "shuv2code\n");
        assert.isFalse(yield* fs.exists(`${home}/.s2code-v2`));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const channel of ["nightly", "preview"])
    it.effect.skipIf(windowsHost)(
      `refuses unmarked ${channel} state in runner, launch and pairing before populating it`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "ssh-unmarked-channel-" });
          const home = `${root}/home`;
          const channelHome = `${home}/.s2code-v2-${channel}`;
          yield* fs.makeDirectory(`${channelHome}/userdata`, { recursive: true });
          yield* fs.writeFileString(`${channelHome}/userdata/statev2.sqlite`, "upstream-state");
          const input = {
            archiveVersion: `1.2.3-${channel}.20261014.1`,
            releaseBaseUrl: "https://fixture.invalid",
          };
          const scripts = [
            SshTunnel.buildRemoteT3RunnerScript(input),
            SshTunnel.buildRemoteLaunchScript(input),
            SshTunnel.buildRemotePairingScript("fixture", input),
          ];
          for (const script of scripts) {
            const file = `${root}/runner.sh`;
            yield* fs.writeFileString(file, script);
            const result = yield* runRunner(home, file);
            assert.notEqual(result.exitCode, 0);
            assert.include(result.stderr, "Cannot establish product ownership");
            assert.deepEqual(yield* fs.readDirectory(channelHome), ["userdata"]);
            assert.equal(
              yield* fs.readFileString(`${channelHome}/userdata/statev2.sqlite`),
              "upstream-state",
            );
          }
        }).pipe(Effect.provide(NodeServices.layer)),
    );

  for (const channel of ["nightly", "preview"])
    it.effect.skipIf(windowsHost)(
      `installs the ${channel} SSH runtime without touching stable caches`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "ssh-channel-runtime-" });
          const version = `1.2.3-${channel}.20261014.1`;
          const releaseBaseUrl = yield* makeMirror(root, version, channel === "nightly");
          const home = `${root}/home`;
          const stableCache = `${home}/.s2code-v2/runtime/versions/1.2.3`;
          yield* fs.makeDirectory(stableCache, { recursive: true });
          yield* fs.writeFileString(`${stableCache}/t3`, "stable-executable");
          const runner = `${root}/run-t3.sh`;
          yield* fs.writeFileString(
            runner,
            SshTunnel.buildRemoteT3RunnerScript({ archiveVersion: version, releaseBaseUrl }),
          );
          const result = yield* runRunner(home, runner);
          assert.equal(result.exitCode, 0, result.stderr);
          assert.include(result.stdout, `t3 v${version}`);
          assert.equal(yield* fs.readFileString(`${stableCache}/t3`), "stable-executable");
          assert.equal(
            yield* fs.readFileString(`${home}/.s2code-v2-${channel}/.product-identity`),
            "s2code\n",
          );
          assert.equal(
            (yield* fs.readFileString(
              `${home}/.s2code-v2-${channel}/runtime/versions/${version}/.install-complete`,
            )).trim(),
            version,
          );
        }).pipe(Effect.provide(NodeServices.layer)),
    );

  it.effect.skipIf(windowsHost)(
    "restores the old remote cache after a failed publish, or retains both copies when restoration fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const failRestore of [false, true]) {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "fork-ssh-publish-" });
          const releaseBaseUrl = yield* makeMirror(root);
          const runner = `${root}/run.sh`;
          yield* fs.writeFileString(
            runner,
            SshTunnel.buildRemoteT3RunnerScript({ archiveVersion, releaseBaseUrl }),
          );
          const home = `${root}/home`;
          const versions = `${home}/.s2code-v2-preview/runtime/versions`;
          const cache = `${versions}/${archiveVersion}`;
          yield* fs.makeDirectory(cache, { recursive: true });
          yield* fs.writeFileString(`${home}/.s2code-v2-preview/.product-identity`, "s2code\n");
          yield* fs.writeFileString(`${cache}/t3`, "old-runtime");
          yield* fs.writeFileString(`${cache}/.install-complete`, archiveVersion);
          yield* fs.makeDirectory(`${root}/bin`);
          yield* fs.writeFileString(
            `${root}/bin/mv`,
            `#!/bin/sh\ncase "$1" in */.staging-*${failRestore ? "|*/.previous-*" : ""}) exit 55 ;; esac\nexec /bin/mv "$@"\n`,
          );
          yield* fs.chmod(`${root}/bin/mv`, 0o755);
          const result = yield* runRunner(home, runner, `${root}/bin:${process.env.PATH ?? ""}`);
          assert.notEqual(result.exitCode, 0);
          const entries = yield* fs.readDirectory(versions);
          if (!failRestore) {
            assert.equal(yield* fs.readFileString(`${cache}/t3`), "old-runtime");
            assert.deepEqual(entries, [archiveVersion]);
          } else {
            const backup = entries.find((name) => name.startsWith(".previous-"));
            const staging = entries.find((name) => name.startsWith(".staging-"));
            assert.isDefined(backup);
            assert.isDefined(staging);
            assert.equal(
              yield* fs.readFileString(`${versions}/${backup}/runtime/t3`),
              "old-runtime",
            );
            assert.include(yield* fs.readFileString(`${versions}/${staging}/t3`), archiveVersion);
            assert.include(result.stderr, "Could not restore runtime");
          }
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(windowsHost)(
    "refetches unmarked caches and refuses foreign-marked caches without executing them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-archive-ownership-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-t3.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteT3RunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        const cache = `${home}/.s2code-v2-preview/runtime/versions/${archiveVersion}`;
        yield* fs.makeDirectory(cache, { recursive: true });
        yield* fs.writeFileString(`${home}/.s2code-v2-preview/.product-identity`, "s2code\n");
        const sentinel = "#!/bin/sh\necho upstream-sentinel\nexit 1\n";
        yield* fs.writeFileString(`${cache}/t3`, sentinel);
        yield* fs.chmod(`${cache}/t3`, 0o755);
        yield* fs.writeFileString(`${cache}/.install-complete`, archiveVersion);
        const installed = yield* runRunner(home, runner);
        assert.equal(installed.exitCode, 0, installed.stderr);
        assert.notInclude(installed.stdout + installed.stderr, "upstream-sentinel");
        assert.equal((yield* fs.readFileString(`${cache}/.install-product`)).trim(), "s2code");
        // This is the exact retained launcher's completion predicate.
        assert.equal(
          (yield* fs.readFileString(`${cache}/.install-complete`)).trim(),
          archiveVersion,
        );
        yield* fs.writeFileString(`${cache}/t3`, sentinel);
        yield* fs.writeFileString(`${cache}/.install-product`, "t3code\n");
        const refused = yield* runRunner(home, runner);
        assert.notEqual(refused.exitCode, 0);
        assert.include(refused.stderr, "foreign runtime cache");
        assert.equal(yield* fs.readFileString(`${cache}/t3`), sentinel);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
