// @effect-diagnostics nodeBuiltinImport:off - Serves a fake GitHub Release over real HTTP to the published launcher.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";

import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  cliArchiveFileName,
  npmReleaseDatabaseMigration,
} from "@t3tools/shared/cliRelease";

import { buildNpmLauncher } from "./build-npm-launcher.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeChecksums = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Struct({ archive: Schema.String, sha256: Schema.String })),
  ),
);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (
  root: string,
  executable = `#!/bin/sh
if [ -n "$T3CODE_TEST_CALLS" ]; then echo "$*|$T3CODE_NPM_LAUNCHER_PATH" >> "$T3CODE_TEST_CALLS"; fi
if [ "$1" = "--version" ]; then echo "${VERSION}"; exit 0; fi
echo "stub $* launcher=$T3CODE_NPM_LAUNCHER_PATH"
exit 7
`,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const archiveName = cliArchiveFileName(
    VERSION,
    key as (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number],
  );
  const stem = archiveName.replace(/\.tar\.gz$/, "");
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  yield* fs.writeFileString(path.join(root, "release", stem, "t3"), executable);
  yield* fs.chmod(path.join(root, "release", stem, "t3"), 0o755);
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: (yield* HostProcess.Environment).PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  let archive = yield* fs.readFile(path.join(root, "release", archiveName));
  // The launcher's checksums.json needs every supported archive; only this host's one is served.
  const archivesDir = path.join(root, "archives");
  yield* fs.makeDirectory(archivesDir);
  for (const other of CLI_ARCHIVE_PLATFORM_KEYS) {
    yield* fs.writeFile(
      path.join(archivesDir, cliArchiveFileName(VERSION, other)),
      cliArchiveFileName(VERSION, other) === archiveName
        ? archive
        : new TextEncoder().encode(other),
    );
  }
  const requests: Array<string> = [];
  const file = `/v${VERSION}/${archiveName}`;
  let mode: "ok" | "redirect" | "truncate" | "stall" = "ok";
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === file && mode === "redirect") {
      // GitHub answers release downloads with a redirect to its storage host.
      response.writeHead(302, { Location: `/storage${file}` }).end();
    } else if (request.url === file || request.url === `/storage${file}`) {
      response.writeHead(200, { "Content-Length": archive.length });
      if (mode === "truncate")
        response.write(archive.subarray(0, archive.length >> 1), () => response.destroy());
      else if (mode === "stall") response.write(archive.subarray(0, 64));
      else response.end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    archivesDir,
    sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    tamper: () => {
      archive = Buffer.concat([archive, Buffer.from("tampered")]);
    },
    serve: (next: typeof mode) => {
      mode = next;
    },
  };
});

/** What the launcher records after installing: the version, then the executable's sha256. */
const markComplete = Effect.fn("test.markComplete")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executable = yield* fs.readFile(path.join(dir, "t3"));
  const hash = NodeCrypto.createHash("sha256").update(executable).digest("hex");
  yield* fs.writeFileString(path.join(dir, ".install-complete"), `${VERSION}\n${hash}\n`);
});

/** The launcher's cache under a given HOME; tests clear the environment, so XDG_CACHE_HOME is unset. */
const runtimeDir = (home: string) =>
  `${home}/${HostProcess.Platform.defaultValue() === "darwin" ? "Library/Caches" : ".cache"}/s2code/runtime`;

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-launcher-test-" });
        const release = yield* serveFakeRelease(root);
        const output = yield* buildNpmLauncher({
          version: VERSION,
          archivesDir: release.archivesDir,
          outputDir: path.join(root, "out"),
        });

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, "shuv2code");
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.bin, {
          shuv2code: "./bin/shuv2code.mjs",
          s2code: "./bin/shuv2code.mjs",
          s2c: "./bin/shuv2code.mjs",
        });
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);
        assert.isAbove(npmReleaseDatabaseMigration(manifest) ?? 0, 0);
        const checksums = yield* decodeChecksums(
          yield* fs.readFileString(path.join(output.packageDir, "checksums.json")),
        );
        assert.deepStrictEqual(
          Object.keys(checksums).sort(),
          [...CLI_ARCHIVE_PLATFORM_KEYS].sort(),
        );
        const hostKey = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
        assert.deepStrictEqual(checksums[hostKey], {
          archive: cliArchiveFileName(
            VERSION,
            hostKey as (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number],
          ),
          sha256: release.sha256,
        });

        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: (yield* HostProcess.Environment).PATH },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const packageDir = path.join(installed, "package");

        const home = path.join(root, "home");
        const env = {
          PATH: (yield* HostProcess.Environment).PATH,
          HOME: home,
          T3CODE_TEST_CALLS: path.join(root, "calls"),
          S2CODE_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = path.join(packageDir, "bin/shuv2code.mjs");
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(first.stdout.trim(), `stub serve a b launcher=${launcher}`, first.stderr);
        assert.equal(first.exitCode, 7);
        assert.deepStrictEqual(
          (yield* fs.readFileString(env.T3CODE_TEST_CALLS)).trim().split("\n"),
          ["--version|", `serve a b|${launcher}`],
        );
        const versionDir = path.join(runtimeDir(home), VERSION);
        const marker = yield* fs.readFileString(path.join(versionDir, ".install-complete"));
        assert.equal(
          marker,
          `${VERSION}\n${NodeCrypto.createHash("sha256")
            .update(yield* fs.readFile(path.join(versionDir, "t3")))
            .digest("hex")}\n`,
        );
        assert.isTrue(yield* fs.exists(path.join(versionDir, "node_modules/native")));
        assert.deepStrictEqual((yield* fs.readDirectory(runtimeDir(home))).sort(), [VERSION]);

        const requestsAfterFirst = release.requests.length;
        const second = yield* run(process.execPath, [launcher, "--version"], { cwd: root, env });
        assert.equal(second.exitCode, 0);
        assert.equal(release.requests.length, requestsAfterFirst);
        assert.deepStrictEqual(
          (yield* fs.readFileString(env.T3CODE_TEST_CALLS)).trim().split("\n"),
          ["--version|", `serve a b|${launcher}`, `--version|${launcher}`],
        );

        // A cached executable that no longer has its recorded hash is downloaded again.
        yield* fs.writeFileString(path.join(versionDir, "t3"), "#!/bin/sh\necho swapped\n");
        const reverified = yield* run(process.execPath, [launcher, "serve"], { cwd: root, env });
        assert.include(reverified.stderr, "no longer matches its recorded sha256");
        assert.equal(reverified.stdout.trim(), `stub serve launcher=${launcher}`);
        assert.equal(reverified.exitCode, 7);
        assert.equal(release.requests.length, requestsAfterFirst + 1);
        assert.equal(yield* fs.readFileString(path.join(versionDir, ".install-complete")), marker);

        // One whose hash matches its marker but cannot start is reported, not re-downloaded.
        yield* fs.writeFileString(path.join(versionDir, "t3"), "#!/t3-test-missing-loader\n");
        yield* markComplete(versionDir);
        for (const _attempt of [1, 2]) {
          const cached = yield* run(process.execPath, [launcher, "serve"], { cwd: root, env });
          assert.equal(cached.exitCode, 1, cached.stderr);
          assert.include(cached.stderr, "could not run");
          assert.equal(release.requests.length, requestsAfterFirst + 1);
        }

        const ipcServer = path.join(runtimeDir(home), VERSION, "t3");
        yield* fs.writeFileString(
          ipcServer,
          `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(23));\nprocess.on("message", (m) => process.send({ reply: m }));\nprocess.send({ args: process.argv.slice(2) });\n`,
        );
        yield* markComplete(path.dirname(ipcServer));
        const legacy = NodeChildProcess.fork(
          path.join(packageDir, "dist/bin.mjs"),
          ["__service-preflight", "a b"],
          { env, silent: true },
        );
        yield* Effect.promise(async () => {
          assert.deepStrictEqual((await NodeEvents.EventEmitter.once(legacy, "message"))[0], {
            args: ["__service-preflight", "a b"],
          });
          const reply = NodeEvents.EventEmitter.once(legacy, "message");
          legacy.send({ type: "trial-accepted" });
          assert.deepStrictEqual((await reply)[0], { reply: { type: "trial-accepted" } });
          const exit = NodeEvents.EventEmitter.once(legacy, "exit");
          legacy.kill("SIGTERM");
          assert.deepStrictEqual(await exit, [23, null]);
        });

        const raceHome = path.join(root, "race-home");
        const launch = run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, HOME: raceHome },
        });
        const [one, two] = yield* Effect.all([launch, launch], { concurrency: "unbounded" });
        assert.equal(one.exitCode, 0, one.stderr);
        assert.equal(two.exitCode, 0, two.stderr);
        assert.deepStrictEqual(yield* fs.readDirectory(runtimeDir(raceHome)), [VERSION]);

        // A peer's executable and sidecar stay available after every later rename or removal,
        // even when it publishes after our missing-marker read.
        const staleHome = path.join(root, "stale-home");
        const staleDir = path.join(runtimeDir(staleHome), VERSION);
        const peerDir = path.join(root, "peer-runtime");
        yield* fs.makeDirectory(staleDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleDir, "t3"), "");
        yield* fs.makeDirectory(peerDir);
        yield* fs.writeFileString(path.join(peerDir, "t3"), '#!/bin/sh\necho "peer $*"\nexit 7\n');
        yield* fs.chmod(path.join(peerDir, "t3"), 0o755);
        yield* markComplete(peerDir);
        yield* fs.writeFileString(path.join(peerDir, "sidecar"), "peer sidecar");
        const peerChecks = path.join(root, "peer-checks.txt");
        // The peer publishes after the launcher's rename fails and it reads the marker.
        const peerHook = path.join(root, "peer-publishes.mjs");
        yield* fs.writeFileString(
          peerHook,
          `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const dir = ${JSON.stringify(staleDir)};
const { readFileSync, renameSync, rmSync } = fs;
let checking = false;
let published = false;
const checkPeer = () => {
  const child = spawnSync(dir + "/t3", ["--version"], { encoding: "utf8" });
  let sidecar;
  try {
    sidecar = readFileSync(dir + "/sidecar", "utf8");
  } catch (error) {
    sidecar = error.code;
  }
  fs.appendFileSync(${JSON.stringify(peerChecks)},
    [child.status, child.error?.code ?? child.stdout.trim(), sidecar].join("|") + "\\n");
};
fs.renameSync = (from, to) => {
  try {
    return renameSync(from, to);
  } catch (error) {
    checking ||= to === dir;
    throw error;
  } finally {
    if (published) checkPeer();
  }
};
fs.rmSync = (...args) => {
  try {
    return rmSync(...args);
  } finally {
    if (published) checkPeer();
  }
};
fs.readFileSync = (file, ...rest) => {
  try {
    return readFileSync(file, ...rest);
  } finally {
    if (checking && file === dir + "/.install-complete") {
      checking = false;
      rmSync(dir, { recursive: true });
      renameSync(${JSON.stringify(peerDir)}, dir);
      published = true;
      checkPeer();
    }
  }
};
`,
        );
        const recovered = yield* run(
          process.execPath,
          ["--import", peerHook, launcher, "--version"],
          { cwd: root, env: { ...env, HOME: staleHome } },
        );
        const checks = (yield* fs.readFileString(peerChecks)).trim().split("\n");
        assert.isAtLeast(checks.length, 2);
        assert.deepStrictEqual([...new Set(checks)], ["7|peer --version|peer sidecar"]);
        assert.equal(recovered.stdout.trim(), "peer --version", recovered.stderr);
        assert.equal(recovered.exitCode, 7);
        assert.deepStrictEqual(yield* fs.readDirectory(runtimeDir(staleHome)), [VERSION]);

        // While another launch holds the lock, a stale folder is left alone and the error says
        // how to clear a lock left by a crash.
        const staleOnlyHome = path.join(root, "stale-only-home");
        const staleOnlyDir = path.join(runtimeDir(staleOnlyHome), VERSION);
        yield* fs.makeDirectory(staleOnlyDir, { recursive: true });
        yield* fs.writeFileString(path.join(staleOnlyDir, "t3"), "incomplete");
        yield* fs.makeDirectory(`${staleOnlyDir}.lock`);
        const locked = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, HOME: staleOnlyHome },
        });
        assert.equal(locked.exitCode, 1);
        assert.include(locked.stderr, `delete ${staleOnlyDir}.lock`);
        assert.equal(yield* fs.readFileString(path.join(staleOnlyDir, "t3")), "incomplete");

        // Without a peer, the stale folder is replaced by our own download.
        yield* fs.remove(`${staleOnlyDir}.lock`, { recursive: true });
        const replaced = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, HOME: staleOnlyHome },
        });
        assert.equal(replaced.stdout.trim(), VERSION, replaced.stderr);
        assert.equal(replaced.exitCode, 0);
        assert.deepStrictEqual(yield* fs.readDirectory(runtimeDir(staleOnlyHome)), [VERSION]);

        // The hash comes from the package, so a release serving other bytes installs nothing.
        release.tamper();
        const tampered = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, HOME: path.join(root, "other-home") },
        });
        assert.equal(tampered.exitCode, 1);
        assert.include(tampered.stderr, `checksum mismatch for ${checksums[hostKey]?.archive}`);
        assert.include(tampered.stderr, release.sha256);
        assert.deepStrictEqual(
          yield* fs.readDirectory(runtimeDir(path.join(root, "other-home"))),
          [],
        );

        const otherArch = path.join(root, "other-arch.mjs");
        yield* fs.writeFileString(
          otherArch,
          'Object.defineProperty(process, "arch", { value: "riscv64" });\n',
        );
        const unsupported = yield* run(
          process.execPath,
          ["--import", otherArch, launcher, "--version"],
          { cwd: root, env: { ...env, HOME: path.join(root, "unsupported-home") } },
        );
        assert.equal(unsupported.exitCode, 1);
        assert.include(
          unsupported.stderr,
          `${yield* HostProcess.Platform}-riscv64 is not supported`,
        );
        assert.include(unsupported.stderr, "linux-x64");
        assert.include(unsupported.stderr, "win32-x64");
        assert.isFalse(yield* fs.exists(path.join(root, "unsupported-home")));
      }),
  );
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "follows redirects, refuses truncated and stalled downloads, and keeps two cached versions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-transport-test-" });
        const release = yield* serveFakeRelease(root);
        const output = yield* buildNpmLauncher({
          version: VERSION,
          archivesDir: release.archivesDir,
          outputDir: path.join(root, "out"),
        });
        const launcher = path.join(output.packageDir, "bin/shuv2code.mjs");
        const hostArchive = cliArchiveFileName(
          VERSION,
          `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}` as (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number],
        );
        const hostPath = (yield* HostProcess.Environment).PATH;
        const launch = (home: string, extra: Record<string, string> = {}) =>
          run(process.execPath, [launcher, "--version"], {
            cwd: root,
            env: {
              PATH: hostPath,
              HOME: home,
              S2CODE_RELEASE_BASE_URL: release.baseUrl,
              S2CODE_DOWNLOAD_TIMEOUT_SECONDS: "2",
              ...extra,
            },
          });

        release.serve("truncate");
        const truncatedHome = path.join(root, "truncated");
        const truncated = yield* launch(truncatedHome);
        assert.equal(truncated.exitCode, 1);
        assert.match(truncated.stderr, /shuv2code: (GET .* failed|download of .* ended after)/);
        assert.deepStrictEqual(yield* fs.readDirectory(runtimeDir(truncatedHome)), []);

        // The idle watchdog stops a download that stops sending, well before the 2s deadline.
        release.serve("stall");
        const stalledHome = path.join(root, "stalled");
        const stalled = yield* launch(stalledHome);
        assert.equal(stalled.exitCode, 1);
        assert.include(stalled.stderr, "stalled with no data for 1s");
        assert.deepStrictEqual(yield* fs.readDirectory(runtimeDir(stalledHome)), []);

        // Pruning keeps this version and the most recently installed other one, never a peer's
        // in-flight staging folder.
        release.serve("redirect");
        const home = path.join(root, "home");
        const versions = runtimeDir(home);
        for (const [name, installed] of [
          ["0.0.1", 1_000],
          ["0.0.2", 2_000],
        ] as const) {
          yield* fs.makeDirectory(path.join(versions, name), { recursive: true });
          yield* fs.writeFileString(path.join(versions, name, ".install-complete"), `${name}\n`);
          yield* fs.utimes(path.join(versions, name, ".install-complete"), installed, installed);
        }
        yield* fs.makeDirectory(path.join(versions, "0.0.0-unfinished"));
        yield* fs.makeDirectory(path.join(versions, `${VERSION}.staging-peer`));
        const redirected = yield* launch(home);
        assert.equal(redirected.stdout.trim(), VERSION, redirected.stderr);
        assert.include(release.requests, `/storage/v${VERSION}/${hostArchive}`);
        assert.deepStrictEqual((yield* fs.readDirectory(versions)).sort(), [
          "0.0.2",
          VERSION,
          `${VERSION}.staging-peer`,
        ]);

        // A relative XDG_CACHE_HOME is ignored, as the XDG spec requires.
        if ((yield* HostProcess.Platform) === "linux") {
          const xdgHome = path.join(root, "xdg");
          const relative = yield* launch(xdgHome, { XDG_CACHE_HOME: "relative-cache" });
          assert.equal(relative.exitCode, 0, relative.stderr);
          assert.deepStrictEqual(yield* fs.readDirectory(runtimeDir(xdgHome)), [VERSION]);
          assert.isFalse(yield* fs.exists(path.join(root, "relative-cache")));
        }

        const oldNode = path.join(root, "old-node.mjs");
        yield* fs.writeFileString(
          oldNode,
          'Object.defineProperty(process.versions, "node", { value: "16.20.2" });\n',
        );
        const tooOld = yield* run(process.execPath, ["--import", oldNode, launcher, "--version"], {
          cwd: root,
          env: { PATH: hostPath, HOME: path.join(root, "old-node-home") },
        });
        assert.equal(tooOld.exitCode, 1);
        assert.include(tooOld.stderr, "needs Node.js 18 or newer");
        assert.isFalse(yield* fs.exists(path.join(root, "old-node-home")));
      }),
  );
  it.effect("pins only the archives present, and only when told a platform is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-missing-test-" });
      const archivesDir = path.join(root, "archives");
      yield* fs.makeDirectory(archivesDir);
      const build = (allowMissing: boolean) =>
        buildNpmLauncher({
          version: VERSION,
          archivesDir,
          outputDir: path.join(root, "out"),
          allowMissing,
        });
      // Even --allow-missing refuses a launcher that could run nowhere.
      assert.equal((yield* Effect.flip(build(true)))._tag, "NpmLauncherArchivesMissingError");
      for (const key of CLI_ARCHIVE_PLATFORM_KEYS.filter((key) => !key.startsWith("win32-")))
        yield* fs.writeFileString(path.join(archivesDir, cliArchiveFileName(VERSION, key)), key);
      const refused = yield* Effect.flip(build(false));
      assert.equal(refused._tag, "NpmLauncherArchivesMissingError");
      assert.include(refused.message, cliArchiveFileName(VERSION, "win32-x64"));
      const output = yield* build(true);
      const checksums = yield* decodeChecksums(
        yield* fs.readFileString(path.join(output.packageDir, "checksums.json")),
      );
      assert.deepStrictEqual(Object.keys(checksums).sort(), [
        "darwin-arm64",
        "linux-arm64",
        "linux-x64",
      ]);
    }),
  );
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "does not publish an unusable release",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        for (const executable of [
          "#!/t3-test-missing-loader\n",
          '#!/bin/sh\necho "runtime loader failed" >&2\nexit 42\n',
          "#!/bin/sh\nkill -TERM $$\n",
          '#!/bin/sh\ntrap \'echo caught > "$T3CODE_TEST_TERM"; exit 42\' TERM\necho ready > "$T3CODE_TEST_READY"\nwhile :; do :; done\n',
        ]) {
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-npm-validation-test-" });
          const release = yield* serveFakeRelease(root, executable);
          const output = yield* buildNpmLauncher({
            version: VERSION,
            archivesDir: release.archivesDir,
            outputDir: path.join(root, "out"),
          });
          const home = path.join(root, "home");
          const dir = path.join(runtimeDir(home), VERSION);
          const probeTimeoutHook = path.join(root, "probe-timeout.mjs");
          yield* fs.writeFileString(
            probeTimeoutHook,
            `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const { spawnSync } = childProcess;
childProcess.spawnSync = (command, args, options) => spawnSync(command, args,
  options?.timeout === undefined ? options : { ...options, timeout: 500 });
syncBuiltinESMExports();
`,
          );
          const env = {
            PATH: (yield* HostProcess.Environment).PATH,
            HOME: home,
            S2CODE_RELEASE_BASE_URL: release.baseUrl,
            T3CODE_TEST_READY: path.join(root, "probe-ready"),
            T3CODE_TEST_TERM: path.join(root, "probe-term"),
          };
          const launcher = path.join(output.packageDir, "bin/shuv2code.mjs");
          const failed = yield* run(
            process.execPath,
            ["--import", probeTimeoutHook, launcher, "serve"],
            { cwd: root, env },
          );
          assert.equal(failed.exitCode, 1, failed.stderr);
          assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(dir)), [], failed.stderr);
          assert.include(failed.stderr, "could not run");
          if (executable.includes("runtime loader failed")) {
            assert.include(failed.stderr, "runtime loader failed");
          }
          if (executable.includes("trap")) {
            assert.isTrue(yield* fs.exists(env.T3CODE_TEST_READY));
            assert.isFalse(yield* fs.exists(env.T3CODE_TEST_TERM));
          }
          if ((yield* HostProcess.Platform) === "linux") {
            assert.include(failed.stderr, "glibc");
            assert.include(failed.stderr, "musl");
          }
        }
      }),
  );
});
