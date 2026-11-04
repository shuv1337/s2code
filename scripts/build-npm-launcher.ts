#!/usr/bin/env node
/**
 * Builds the `shuv2code` npm launcher: a few kilobytes of JavaScript plus the sha256 of every
 * CLI archive in the release. On first run it downloads its platform's archive from the GitHub
 * Release, checks it against those hashes, and caches it. Writes <output-dir>/shuv2code/ and
 * the publishable <output-dir>/shuv2code.tgz.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { CLI_ARCHIVE_PLATFORM_KEYS, cliArchiveFileName } from "@t3tools/shared/cliRelease";
import { NPM_PACKAGE_NAME } from "@t3tools/shared/productIdentity";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { packDeterministicTarball } from "./lib/npm-tarball.ts";

export const NPM_LAUNCHER_PACKAGE_NAME = NPM_PACKAGE_NAME;

const encodeJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export class NpmLauncherArchivesMissingError extends Schema.TaggedError<NpmLauncherArchivesMissingError>()(
  "NpmLauncherArchivesMissingError",
  { archivesDir: Schema.String, missing: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `${this.archivesDir} lacks ${this.missing.join(", ")}. A launcher without them reports those platforms as unsupported; pass --allow-missing for a release that deliberately left them out.`;
  }
}

export class NpmLauncherPackError extends Schema.TaggedError<NpmLauncherPackError>()(
  "NpmLauncherPackError",
  { tarball: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Packing ${this.tarball} failed.`;
  }
}

/** engines matches the launcher's own Node check (fetch). `t3code` is read back by npmReleaseDatabaseMigration. */
export function npmLauncherPackageManifest(version: string, databaseMigration: number) {
  return {
    name: NPM_LAUNCHER_PACKAGE_NAME,
    version,
    description:
      "S2Code CLI. Downloads the self-contained executable for this platform from the GitHub Release.",
    license: serverPackageJson.license,
    repository: serverPackageJson.repository,
    // Every name earlier shuv2code versions installed, so upgrading removes no command.
    bin: {
      shuv2code: "./bin/shuv2code.mjs",
      s2code: "./bin/shuv2code.mjs",
      s2c: "./bin/shuv2code.mjs",
    },
    files: ["bin", "dist", "checksums.json"],
    engines: { node: ">=18" },
    t3code: { databaseMigration },
  };
}

/** Highest server migration id, from the `NNN_Name.ts` files the server registers. */
const latestServerMigrationId = Effect.fn("latestServerMigrationId")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* path.fromFileUrl(
    new URL("../apps/server/src/persistence/Migrations/", import.meta.url),
  );
  const ids = (yield* fs.readDirectory(dir)).flatMap((name) => {
    const id = /^(\d+)_\w+\.ts$/.exec(name)?.[1];
    return id === undefined ? [] : [Number(id)];
  });
  return Math.max(0, ...ids);
});

/** `{ [platformKey]: { archive, sha256 } }` for each archive present; the launcher trusts nothing else. */
const archiveChecksums = Effect.fn("archiveChecksums")(function* (input: {
  readonly archivesDir: string;
  readonly version: string;
  readonly allowMissing: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archives = CLI_ARCHIVE_PLATFORM_KEYS.map((key) => ({
    key,
    archive: cliArchiveFileName(input.version, key),
  }));
  const present: typeof archives = [];
  const missing: Array<string> = [];
  for (const entry of archives) {
    if (yield* fs.exists(path.join(input.archivesDir, entry.archive))) present.push(entry);
    else missing.push(entry.archive);
  }
  if (missing.length > 0 && (!input.allowMissing || present.length === 0)) {
    return yield* new NpmLauncherArchivesMissingError({ archivesDir: input.archivesDir, missing });
  }
  const checksums: Record<string, { archive: string; sha256: string }> = {};
  for (const { key, archive } of present) {
    const bytes = yield* fs.readFile(path.join(input.archivesDir, archive));
    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));
    checksums[key] = { archive, sha256: Buffer.from(digest).toString("hex") };
  }
  return checksums;
});

export const buildNpmLauncher = Effect.fn("buildNpmLauncher")(function* (input: {
  readonly version: string;
  readonly archivesDir: string;
  readonly outputDir: string;
  readonly allowMissing?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceDir = yield* path.fromFileUrl(new URL("./npm-launcher/", import.meta.url));
  const checksums = yield* archiveChecksums({
    ...input,
    allowMissing: input.allowMissing === true,
  });

  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const scratch = yield* fs.makeTempDirectoryScoped({
    directory: input.outputDir,
    prefix: ".launcher-",
  });
  const stageDir = path.join(scratch, "package");
  yield* fs.makeDirectory(path.join(stageDir, "bin"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageDir, "dist"));
  yield* fs.writeFileString(
    path.join(stageDir, "package.json"),
    `${yield* encodeJson(
      npmLauncherPackageManifest(input.version, yield* latestServerMigrationId()),
    )}\n`,
  );
  yield* fs.writeFileString(
    path.join(stageDir, "checksums.json"),
    `${yield* encodeJson(checksums)}\n`,
  );
  yield* fs.copyFile(
    path.join(sourceDir, "shuv2code.mjs"),
    path.join(stageDir, "bin/shuv2code.mjs"),
  );
  yield* fs.chmod(path.join(stageDir, "bin/shuv2code.mjs"), 0o755);
  yield* fs.copyFile(path.join(sourceDir, "bin.mjs"), path.join(stageDir, "dist/bin.mjs"));
  yield* fs.copyFile(path.join(sourceDir, "README.md"), path.join(stageDir, "README.md"));

  const packageDir = path.join(input.outputDir, NPM_LAUNCHER_PACKAGE_NAME);
  const tarball = path.join(input.outputDir, `${NPM_LAUNCHER_PACKAGE_NAME}.tgz`);
  yield* fs.remove(tarball, { force: true });
  // Reproducible bytes, so a publish rerun matches the integrity of a version already published.
  yield* Effect.tryPromise({
    try: () => packDeterministicTarball(scratch, "package", tarball),
    catch: (cause) => new NpmLauncherPackError({ tarball, cause }),
  });
  yield* fs.remove(packageDir, { recursive: true, force: true });
  yield* fs.rename(stageDir, packageDir);
  yield* Effect.log(`[npm-launcher] Wrote ${packageDir} and ${tarball}`);
  return { packageDir, tarball };
}, Effect.scoped);

const command = Command.make(
  "build-npm-launcher",
  {
    version: Flag.String("version").pipe(
      Flag.withDescription("Exact release version; the launcher downloads this version's archive."),
    ),
    archivesDir: Flag.String("archives-dir").pipe(
      Flag.withDescription("Directory holding the release's s2code-<version>-<platform> archives."),
    ),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("npm-packages")),
    allowMissing: Flag.Boolean("allow-missing").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Pin only the archives present, for a release missing a platform."),
    ),
  },
  buildNpmLauncher,
).pipe(Command.withDescription("Build the shuv2code npm launcher package."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
