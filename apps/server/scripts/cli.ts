#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import { injectLinuxArm64Sea } from "../../../scripts/lib/linux-arm64-sea.ts";
import rootPackageJson from "../../../package.json" with { type: "json" };
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliExecutableImportError,
} from "./cliErrors.ts";
import { publishPlatformsThenLauncher } from "./publishOrder.ts";
import {
  assertForkNpmSet,
  assertForkDistTag,
  forkNpmPublishingReady,
} from "../../../scripts/lib/fork-release.ts";
import { ServerCliPublishGuardError } from "./cliErrors.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found. Skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Cross-build for <platform>-<arch> in nodejs.org naming (for example darwin-x64); defaults to the host.",
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Building single-executable...");
      const target = Option.getOrUndefined(config.target);
      // TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
      const linuxArm64 =
        !target &&
        (yield* HostProcess.Platform) === "linux" &&
        (yield* HostProcess.Architecture) === "arm64";
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            T3CODE_PACK_EXE: linuxArm64 ? "bundle" : "1",
            T3CODE_PACK_EXE_TARGET: target ?? "",
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // Executables reject non-builtin imports even when bundling succeeds; inspect the emitted graph.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      // TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
      if (linuxArm64) {
        yield* injectLinuxArm64Sea({
          bundlePath,
          outputPath: path.join(serverDir, "dist-exe/t3"),
          nodeVersion: rootPackageJson.engines.node,
          verbose: config.verbose,
        });
      }
      yield* Effect.log(
        "[cli] Built dist-exe/t3 (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
      );
    }),
).pipe(
  Command.withDescription(
    `Build the server as a Node single-executable. Native builds require Node ${rootPackageJson.engines.node}; explicit cross-target builds need a Node 25.7+ host for --build-sea. Linux ARM64 builds only on a Linux ARM64 host. The binary still resolves native packages from a node_modules tree beside it.`,
  ),
);

/**
 * Publishes the tarballs scripts/build-npm-platform-packages.ts produced:
 * every `@s2code/t3-<platform>.tgz` first, then both launcher tarballs, so
 * the launcher is never installable before the executables it depends on.
 * Tarballs rather than directories because `npm publish <dir>` strips the
 * `node_modules/` the executable loads its native addons from.
 */
const publishCmd = Command.make(
  "publish",
  {
    packagesDir: Flag.String("packages-dir").pipe(
      Flag.withDescription("Output dir of scripts/build-npm-platform-packages.ts."),
    ),
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const packagesDir = path.resolve(config.packagesDir);
      const publishingEnvironment = yield* Config.all({
        S2CODE_NPM_TRUSTED_PUBLISHING_READY: Config.String(
          "S2CODE_NPM_TRUSTED_PUBLISHING_READY",
        ).pipe(Config.withDefault("")),
        FORK_NPM_TRUSTED_PUBLISHING_READY: Config.String("FORK_NPM_TRUSTED_PUBLISHING_READY").pipe(
          Config.withDefault(""),
        ),
      });
      const scopeDir = path.join(packagesDir, "@s2code");
      const launcherTarball = path.join(packagesDir, "s2code.tgz");
      const bridgeTarball = path.join(packagesDir, "shuv2code.tgz");
      const platformTarballs = (yield* fs
        .readDirectory(scopeDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
        .filter((entry) => entry.startsWith("t3-") && entry.endsWith(".tgz"))
        .sort()
        .map((entry) => path.join(scopeDir, entry));
      if (platformTarballs.length === 0) {
        return yield* new ServerCliBuildAssetMissingError({
          assetPath: path.join(scopeDir, "t3-<platform>.tgz"),
        });
      }
      if (!(yield* fs.exists(launcherTarball))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: launcherTarball });
      }
      if (!(yield* fs.exists(bridgeTarball))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: bridgeTarball });
      }

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const manifestTexts = yield* Effect.forEach(
        [...platformTarballs, launcherTarball, bridgeTarball],
        (file) => spawner.string(ChildProcess.make("tar", ["-xOf", file, "package/package.json"])),
      );
      yield* Effect.try({
        try: () => {
          const manifests = manifestTexts.map((text) => JSON.parse(text) as { version?: string });
          const version = manifests[0]?.version;
          if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
            throw new Error("Invalid fork package version.");
          assertForkNpmSet(manifests, version);
          if (!config.dryRun && !forkNpmPublishingReady(publishingEnvironment))
            throw new Error(
              "New s2code npm publishers and the shuv2code bridge must both be verified before publication.",
            );
          assertForkDistTag(version, config.tag);
          if (config.access !== "public")
            throw new Error("Fork platform distribution must be public.");
        },
        catch: (cause) => new ServerCliPublishGuardError({ cause }),
      });

      const args = ["publish", "--access", config.access, "--tag", config.tag];
      if (config.provenance) args.push("--provenance");
      if (config.dryRun) args.push("--dry-run");

      const publish = Effect.fn("publish")(function* (tarball: string) {
        const spawnCommand = yield* resolveSpawnCommand("npm", [...args, tarball]);
        yield* Effect.log(`[cli] npm ${args.join(" ")} ${path.basename(tarball)}`);
        yield* runCommand(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: packagesDir,
            stdout: config.verbose ? "inherit" : "ignore",
            stderr: "inherit",
            shell: spawnCommand.shell,
          }),
        );
      });

      yield* publishPlatformsThenLauncher({ platformTarballs, launcherTarball, publish });
      yield* publish(bridgeTarball);
    }),
).pipe(
  Command.withDescription(
    "Publish the complete @s2code platform set, s2code launcher and shuv2code compatibility bridge to npm.",
  ),
);

const cli = Command.make("cli").pipe(
  Command.withDescription("S2Code server build & publish CLI."),
  Command.withSubcommands([buildCmd, buildExeCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
