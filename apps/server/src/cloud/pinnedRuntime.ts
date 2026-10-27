import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileNames,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  parseChecksums,
} from "@t3tools/shared/cliRelease";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveChannelIdentity,
  resolveLegacyChannelIdentity,
} from "@t3tools/shared/channelIdentity";

import packageJson from "../../package.json" with { type: "json" };
import * as ProcessRunner from "../processRunner.ts";
import {
  isProductRuntimeComplete,
  isProductRuntimeVersion,
  runtimeCompletionMarker,
  PRODUCT_RUNTIME_MARKER,
  PRODUCT_HOME_MARKER,
  PRODUCT_ID,
  LEGACY_PRODUCT_ID,
  isProductIdentity,
} from "@t3tools/shared/productIdentity";
import { canonicalProductPath, ensureProductHome } from "@t3tools/shared/productHome";
import { isExactServiceVersion, parseServiceState, SERVICE_STATE_FILE } from "./serviceProtocol.ts";

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
const PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT = Duration.minutes(1);
const PINNED_RUNTIME_ARCHIVE_FILE = "t3-runtime-archive";
// Separate layers share one install lock across this process.
const pinnedRuntimeInstallLock = Semaphore.makeUnsafe(1);

export interface PinnedRuntimePaths {
  readonly versionDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export function pinnedRuntimeCommand(paths: PinnedRuntimePaths): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
} {
  return { command: paths.entryPath, args: [] };
}

export function pinnedRuntimeVersionsDir(path: Path.Path, baseDir: string): string {
  return path.join(baseDir, PINNED_RUNTIME_DIR, "versions");
}

export function pinnedRuntimePaths(
  path: Path.Path,
  baseDir: string,
  version: string,
  platform: NodeJS.Platform,
): PinnedRuntimePaths {
  const versionDir = path.join(pinnedRuntimeVersionsDir(path, baseDir), version);
  return {
    versionDir,
    entryPath: path.join(versionDir, platform === "win32" ? "t3.exe" : "t3"),
    sentinelPath: path.join(versionDir, ".install-complete"),
  };
}

export class PinnedRuntimeInstallError extends Schema.TaggedError<PinnedRuntimeInstallError>()(
  "PinnedRuntimeInstallError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Pinned runtime install failed while ${this.step}.`
      : `Pinned runtime install failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class PinnedRuntimePreflightBlockedError extends Schema.TaggedError<PinnedRuntimePreflightBlockedError>()(
  "PinnedRuntimePreflightBlockedError",
  {
    version: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export type PinnedRuntimeProgress =
  | { readonly stage: "download"; readonly received: number; readonly total: number | undefined }
  | { readonly stage: "verify" | "extract" | "validate" | "cached" };

/** Tar writes the executable before native packages; only a validated install gets a sentinel. */

interface PinnedRuntimeInstallInput {
  readonly baseDir: string;
  readonly version: string;
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly validate: (
    paths: PinnedRuntimePaths,
  ) => Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly releaseBaseUrl?: string | undefined;
  readonly onProgress?: (progress: PinnedRuntimeProgress) => void;
}

const fetchReleaseAsset = Effect.fn("cloud.pinned_runtime.fetch_release_asset")(function* (
  httpClient: HttpClient.HttpClient,
  url: string,
  step: string,
  onProgress?: (progress: PinnedRuntimeProgress) => void,
) {
  // Bound stalls while holding the install lock, but allow transfers that keep
  // receiving bytes to finish regardless of their total duration.
  return yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.timeout(PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT),
    Effect.flatMap(
      Effect.fn(function* (response) {
        const length = Number(response.headers["content-length"]);
        const total = Number.isFinite(length) && length > 0 ? length : undefined;
        let received = 0;
        onProgress?.({ stage: "download", received, total });
        const chunks = yield* response.stream.pipe(
          Stream.timeoutOrElse({
            duration: PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT,
            orElse: () => Stream.fail(new Cause.TimeoutError()),
          }),
          Stream.tap((chunk) =>
            Effect.sync(() => {
              received += chunk.byteLength;
              onProgress?.({ stage: "download", received, total });
            }),
          ),
          Stream.runCollect,
        );
        if (total === undefined && received > 0) {
          onProgress?.({ stage: "download", received, total: received });
        }
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      }),
    ),
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: cause._tag === "TimeoutError" ? `${step} (timed out)` : step,
          cause,
        }),
    ),
  );
});

const installFromArchive = Effect.fn("cloud.pinned_runtime.install_archive")(function* (
  input: PinnedRuntimeInstallInput,
  stagingDir: string,
) {
  const { fs, path } = input;
  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  if (platformKey === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
    });
  }
  const httpClient = input.httpClient;
  const baseUrl = cliReleaseDownloadBaseUrl(input.version, input.releaseBaseUrl);
  input.onProgress?.({ stage: "download", received: 0, total: undefined });
  const checksums = parseChecksums(
    new TextDecoder().decode(
      yield* fetchReleaseAsset(
        httpClient,
        `${baseUrl}/${CLI_RELEASE_CHECKSUMS_FILE}`,
        "downloading the t3 release checksums",
      ),
    ),
  );
  const selected = cliArchiveFileNames(input.version, platformKey)
    .map((name) => [name, checksums.get(name)] as const)
    .find((entry): entry is readonly [string, string] => entry[1] !== undefined);
  if (selected === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `finding a ${platformKey} archive in the t3 release checksums`,
    });
  }
  const [fileName, expected] = selected;
  const archive = yield* fetchReleaseAsset(
    httpClient,
    `${baseUrl}/${fileName}`,
    "downloading the t3 release archive",
    input.onProgress,
  );
  input.onProgress?.({ stage: "verify" });
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", archive),
    catch: (cause) =>
      new PinnedRuntimeInstallError({ step: "verifying the t3 release archive", cause }),
  });
  if (Hex.encode(new Uint8Array(digest)) !== expected) {
    return yield* new PinnedRuntimeInstallError({
      step: "verifying the t3 release archive checksum",
    });
  }

  const archivePath = path.join(stagingDir, PINNED_RUNTIME_ARCHIVE_FILE);
  yield* fs
    .writeFile(archivePath, archive)
    .pipe(
      Effect.mapError(
        (cause) => new PinnedRuntimeInstallError({ step: "writing the t3 release archive", cause }),
      ),
    );
  input.onProgress?.({ stage: "extract" });
  const extractStep = "extracting the t3 release archive";
  // Strip the archive's stem directory so the executable lands at <versionDir>/t3.
  yield* input.runner
    .run({
      command: cliArchiveTarCommand(input.platform, process.env),
      args: ["-xf", archivePath, "-C", stagingDir, "--strip-components=1"],
      timeout: PINNED_RUNTIME_INSTALL_TIMEOUT,
    })
    .pipe(
      Effect.mapError((cause) => new PinnedRuntimeInstallError({ step: extractStep, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new PinnedRuntimeInstallError({
            step: extractStep,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
    );
  yield* fs.remove(archivePath, { force: true }).pipe(Effect.ignore);
});

const installPinnedRuntime = Effect.fn("cloud.pinned_runtime.ensure_installed")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const { fs } = input;
  if (!isProductRuntimeVersion(input.version))
    return yield* new PinnedRuntimeInstallError({ step: "validating the release version" });
  const paths = pinnedRuntimePaths(input.path, input.baseDir, input.version, input.platform);
  yield* Effect.try({
    try: () => {
      ensureProductHome(input.baseDir);
      if (
        !canonicalProductPath(input.path.join(paths.versionDir, PRODUCT_RUNTIME_MARKER)).startsWith(
          `${canonicalProductPath(input.baseDir)}${input.path.sep}`,
        )
      )
        throw new Error("Runtime product metadata points outside the fork home.");
      if (
        !canonicalProductPath(paths.versionDir).startsWith(
          `${canonicalProductPath(input.baseDir)}${input.path.sep}`,
        )
      )
        throw new Error("Runtime cache points outside the fork home.");
      if (
        !canonicalProductPath(paths.entryPath).startsWith(
          `${canonicalProductPath(input.baseDir)}${input.path.sep}`,
        )
      )
        throw new Error("Runtime executable points outside the fork home.");
      if (
        !canonicalProductPath(paths.sentinelPath).startsWith(
          `${canonicalProductPath(input.baseDir)}${input.path.sep}`,
        )
      )
        throw new Error("Runtime metadata points outside the fork home.");
    },
    catch: (cause) =>
      new PinnedRuntimeInstallError({ step: "validating product ownership", cause }),
  });
  const homeProduct = yield* fs
    .readFileString(input.path.join(input.baseDir, PRODUCT_HOME_MARKER))
    .pipe(
      Effect.map((value) => value.trim()),
      Effect.mapError(
        (cause) => new PinnedRuntimeInstallError({ step: "reading home product metadata", cause }),
      ),
    );
  if (!isProductIdentity(homeProduct)) {
    return yield* new PinnedRuntimeInstallError({ step: "refusing a foreign product home" });
  }
  const [versionDirExists, entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.versionDir),
    fs.exists(paths.entryPath),
    fs
      .exists(paths.sentinelPath)
      .pipe(
        Effect.flatMap((exists) =>
          exists
            ? fs.readFileString(paths.sentinelPath).pipe(Effect.asSome)
            : Effect.succeed(Option.none<string>()),
        ),
      ),
  ]).pipe(
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "checking the pinned runtime", cause }),
    ),
  );
  const productPath = input.path.join(paths.versionDir, PRODUCT_RUNTIME_MARKER);
  const product = yield* fs.exists(productPath).pipe(
    Effect.flatMap((exists) => (exists ? fs.readFileString(productPath) : Effect.succeed(""))),
    Effect.mapError(
      (cause) => new PinnedRuntimeInstallError({ step: "reading runtime product metadata", cause }),
    ),
  );
  if (
    (yield* fs.exists(productPath)) &&
    !isProductIdentity(product.trim()) &&
    !PRODUCT_ID.startsWith(product.trim()) &&
    !LEGACY_PRODUCT_ID.startsWith(product.trim())
  )
    return yield* new PinnedRuntimeInstallError({ step: "refusing a foreign runtime cache" });
  const alreadyPinned =
    entryExists &&
    Option.isSome(sentinel) &&
    isProductRuntimeComplete(sentinel.value, input.version, product);
  if (alreadyPinned) {
    input.onProgress?.({ stage: "cached" });
    yield* input.validate(paths);
    return paths;
  }
  const versionsDir = input.path.dirname(paths.versionDir);
  yield* fs.makeDirectory(versionsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: "preparing the pinned runtime directory",
          cause,
        }),
    ),
  );
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: ".staging-",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new PinnedRuntimeInstallError({
            step: "preparing the pinned runtime directory",
            cause,
          }),
      ),
    );
  const stagingPaths: PinnedRuntimePaths = {
    versionDir: stagingDir,
    entryPath: input.path.join(stagingDir, input.path.relative(paths.versionDir, paths.entryPath)),
    sentinelPath: input.path.join(stagingDir, ".install-complete"),
  };
  let retainStaging = false;
  const renameRuntime = (source: string, destination: string) =>
    Effect.suspend(() => fs.rename(source, destination)).pipe(
      Effect.retry({
        times: input.platform === "win32" ? 4 : 0,
        schedule: Schedule.spaced("50 millis"),
      }),
    );

  return yield* Effect.gen(function* () {
    yield* installFromArchive(input, stagingDir);

    input.onProgress?.({ stage: "validate" });
    yield* input.validate(stagingPaths);
    yield* fs.writeFileString(
      input.path.join(stagingDir, PRODUCT_RUNTIME_MARKER),
      `${homeProduct}\n`,
    );
    yield* fs
      .writeFileString(stagingPaths.sentinelPath, runtimeCompletionMarker(input.version))
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({ step: "recording the completed install", cause }),
        ),
      );
    retainStaging = true;
    if (versionDirExists) {
      // Nonempty directory replacement is not portable. Keep the old tree in a
      // same-filesystem backup until publication succeeds, and mask cancellation
      // across the two renames. If rollback also fails, retain and report both
      // the old backup and the validated staging tree rather than deleting either.
      const backupDir = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const currentProduct = yield* fs.exists(productPath).pipe(
            Effect.flatMap((exists) =>
              exists ? fs.readFileString(productPath) : Effect.succeed(PRODUCT_ID),
            ),
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "checking runtime ownership before replacement",
                  cause,
                }),
            ),
          );
          if (
            !isProductIdentity(currentProduct.trim()) &&
            !PRODUCT_ID.startsWith(currentProduct.trim()) &&
            !LEGACY_PRODUCT_ID.startsWith(currentProduct.trim())
          )
            return yield* new PinnedRuntimeInstallError({
              step: "refusing a foreign runtime cache",
            });
          const backupParent = yield* fs
            .makeTempDirectory({ directory: versionsDir, prefix: ".previous-" })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({ step: "preparing the runtime backup", cause }),
              ),
            );
          // A fresh child avoids Windows renames onto a just-deleted temp name.
          const backup = input.path.join(backupParent, "runtime");
          yield* renameRuntime(paths.versionDir, backup).pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "preserving the previous pinned runtime",
                  cause,
                }),
            ),
          );
          yield* renameRuntime(stagingDir, paths.versionDir).pipe(
            Effect.catch((cause) =>
              renameRuntime(backup, paths.versionDir).pipe(
                Effect.mapError(
                  (restoreCause) =>
                    new PinnedRuntimeInstallError({
                      step: `restoring the previous pinned runtime preserved at ${backup}; validated replacement retained at ${stagingDir}`,
                      cause: restoreCause,
                    }),
                ),
                Effect.tap(() =>
                  Effect.sync(() => {
                    retainStaging = false;
                  }),
                ),
                Effect.andThen(
                  fs.remove(backupParent, { recursive: true, force: true }).pipe(Effect.ignore),
                ),
                Effect.andThen(
                  Effect.fail(
                    new PinnedRuntimeInstallError({ step: "publishing the pinned runtime", cause }),
                  ),
                ),
              ),
            ),
          );
          retainStaging = false;
          return backupParent;
        }),
      );
      yield* fs.remove(backupDir, { recursive: true, force: true }).pipe(Effect.ignore);
      return paths;
    }
    const published = yield* renameRuntime(stagingDir, paths.versionDir).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.all([
          fs.exists(paths.entryPath),
          fs.readFileString(paths.sentinelPath).pipe(Effect.option),
          fs.readFileString(productPath).pipe(Effect.orElseSucceed(() => "")),
        ]).pipe(
          Effect.mapError(
            (checkCause) =>
              new PinnedRuntimeInstallError({
                step: "checking a concurrently published pinned runtime",
                cause: checkCause,
              }),
          ),
          Effect.flatMap(([publishedEntryExists, publishedSentinel, publishedProduct]) =>
            publishedEntryExists &&
            Option.isSome(publishedSentinel) &&
            isProductRuntimeComplete(publishedSentinel.value, input.version, publishedProduct)
              ? Effect.succeed(false)
              : Effect.fail(
                  new PinnedRuntimeInstallError({
                    step: "publishing the pinned runtime",
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    if (!published) yield* input.validate(paths);
    retainStaging = false;
    return paths;
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        retainStaging
          ? Effect.void
          : fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    ),
  );
});

export const ensurePinnedRuntimeInstalled = (input: PinnedRuntimeInstallInput) =>
  pinnedRuntimeInstallLock.withPermit(installPinnedRuntime(input));

const PINNED_RUNTIME_PRUNED_PREFIX = ".pruned-";
/**
 * Another process may have just published a runtime it has not yet pointed anything at: an
 * update, a downgrade, or the install script between unpacking and linking. The install lock only
 * covers this process, so recently completed runtimes are left for a later prune.
 */
const PINNED_RUNTIME_PRUNE_GRACE = Duration.hours(1);
/**
 * One `t3` launcher path per line, appended by the install scripts and by any prune that finds a
 * launcher on PATH. A service does not see the installer's `T3CODE_INSTALL_BIN_DIR` or the
 * interactive PATH, so this is how it finds a custom one, including installs that predate the file.
 */
const PINNED_RUNTIME_LAUNCHERS_FILE = "launchers";

export function launcherOwnsVersionsDir(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
): boolean {
  const relative = path.relative(versionsDir, path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The executable a `t3.cmd` shim written by the install script or `t3 update` runs. */
export const windowsShimTarget = (contents: string) => /^"([^"]+)"/m.exec(contents)?.[1];

/** Where the `t3` launchers written by the install scripts and `t3 update` point. */
const shellLauncherTargets = Effect.fn("cloud.pinned_runtime.shell_launcher_targets")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  // Every fork command name an install script or update may have linked into this home.
  const launcherNames = [
    resolveChannelIdentity(packageJson.version).executableName,
    resolveLegacyChannelIdentity(packageJson.version).executableName,
    "s2c",
  ].map((name) => (platform === "win32" ? `${name}.cmd` : name));
  const launchersFile = path.join(baseDir, PINNED_RUNTIME_DIR, PINNED_RUNTIME_LAUNCHERS_FILE);
  const recorded = (yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => "")))
    .split(/\r?\n/)
    .filter((launcher) => launcher.trim().length > 0);
  const found = [
    environment["T3CODE_INSTALL_BIN_DIR"] || path.join(home, ".local", "bin"),
    ...(environment["PATH"] ?? environment["Path"] ?? "").split(platform === "win32" ? ";" : ":"),
  ]
    .filter((directory) => path.isAbsolute(directory))
    .flatMap((directory) => launcherNames.map((name) => path.join(directory, name)));
  const versionsDir = pinnedRuntimeVersionsDir(path, baseDir);
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));
  const unrecorded: Array<string> = [];
  const targets: Array<string> = [];
  for (const launcher of [...recorded, ...found]) {
    const target =
      platform === "win32"
        ? yield* fs.readFileString(launcher).pipe(
            Effect.map(windowsShimTarget),
            Effect.orElseSucceed(() => undefined),
          )
        : // Fully resolved, through chained links and a symlinked T3 home alike.
          yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => undefined));
    if (target === undefined) continue;
    targets.push(target);
    if (
      (launcherOwnsVersionsDir(path, versionsDir, target) ||
        launcherOwnsVersionsDir(path, realVersionsDir, target)) &&
      !recorded.includes(launcher) &&
      !unrecorded.includes(launcher)
    ) {
      unrecorded.push(launcher);
    }
  }
  if (unrecorded.length > 0) {
    yield* fs
      .writeFileString(launchersFile, unrecorded.map((launcher) => `${launcher}\n`).join(""), {
        flag: "a",
      })
      .pipe(Effect.ignore);
  }
  return targets;
});

/**
 * Resolved executables rather than command lines: a server started through the `t3` symlink
 * shows up as `t3 serve`, possibly from another T3 home that runs this home's runtimes. Windows
 * has no symlink launcher, and its `t3.cmd` shim runs the absolute path, so command lines do there.
 */
const runningExecutables = Effect.fn("cloud.pinned_runtime.running_executables")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  if (platform === "linux") {
    const pids = yield* fs.readDirectory("/proc").pipe(Effect.option);
    if (Option.isNone(pids)) return Option.none<string>();
    const executables: Array<string> = [];
    for (const pid of pids.value) {
      if (!/^\d+$/.test(pid)) continue;
      // Unreadable ones belong to other users or are this user's non-dumpable daemons (systemd
      // --user, ssh-agent). Neither runs a t3 runtime, and bailing on them would never prune.
      const executable = yield* fs.readLink(`/proc/${pid}/exe`).pipe(Effect.option);
      if (Option.isSome(executable)) executables.push(executable.value);
    }
    return executables.length === 0 ? Option.none<string>() : Option.some(executables.join("\n"));
  }
  const result = yield* runner
    .run({
      ...(platform === "win32"
        ? {
            command: "powershell.exe",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
            ],
          }
        : { command: "lsof", args: ["-nP", "-w", "-d", "txt", "-F", "n"] }),
      timeout: Duration.seconds(10),
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(Effect.option);
  return Option.isSome(result) && result.value.code === 0 && result.value.stdout.length > 0
    ? Option.some(result.value.stdout)
    : Option.none<string>();
});

const selectUnusedRuntimes = Effect.fn("cloud.pinned_runtime.select_unused")(function* (input: {
  readonly baseDir: string;
  readonly keep: ReadonlyArray<string>;
  readonly references: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const entries = yield* fs.readDirectory(versionsDir).pipe(Effect.orElseSucceed(() => []));
  // An interrupted prune has already renamed its runtime out of the way.
  const pruned = new Set(
    entries
      .filter((entry) => entry.startsWith(PINNED_RUNTIME_PRUNED_PREFIX))
      .map((entry) => path.join(versionsDir, entry)),
  );

  const settledBefore =
    (yield* Clock.currentTimeMillis) - Duration.toMillis(PINNED_RUNTIME_PRUNE_GRACE);
  const completed: Array<string> = [];
  for (const version of entries) {
    if (!isExactServiceVersion(version)) continue;
    const versionDir = path.join(versionsDir, version);
    const sentinelPath = path.join(versionDir, ".install-complete");
    const isLink = yield* fs.readLink(versionDir).pipe(Effect.isSuccess);
    const sentinel = yield* fs.readFileString(sentinelPath).pipe(Effect.option);
    const completedAt = yield* fs.stat(sentinelPath).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      !isLink &&
      Option.isSome(sentinel) &&
      sentinel.value.trim() === version &&
      completedAt !== undefined &&
      completedAt < settledBefore
    ) {
      completed.push(version);
    }
  }
  if (completed.length === 0) return pruned;

  const keep = new Set(input.keep);
  const stateText = yield* fs
    .readFileString(path.join(input.baseDir, PINNED_RUNTIME_DIR, SERVICE_STATE_FILE))
    .pipe(
      Effect.asSome,
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? Option.none<string>() : undefined),
      ),
    );
  // State this version cannot read may reference runtimes in ways it does not know.
  if (stateText === undefined) return pruned;
  if (Option.isSome(stateText)) {
    const state = parseServiceState(stateText.value);
    if (state === undefined) return pruned;
    keep.add(state.activeVersion);
    if (state.update !== undefined) {
      keep.add(state.update.fromVersion);
      keep.add(state.update.targetVersion);
    }
  }
  const executables = yield* runningExecutables();
  // Without a process list, a runtime in use would look unused.
  if (Option.isNone(executables)) return pruned;
  const platform = yield* HostProcess.Platform;
  // Windows paths are case-insensitive, and shims and process lists need not agree on case.
  const foldCase = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const references = [
    executables.value,
    ...(yield* shellLauncherTargets(input.baseDir)),
    ...input.references,
  ].map(foldCase);
  // Process executables are resolved, so they name the real path of a symlinked T3 home.
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));

  for (const version of completed) {
    const versionDir = path.join(versionsDir, version);
    const prefixes = [versionDir, path.join(realVersionsDir, version)].map((dir) =>
      foldCase(dir + path.sep),
    );
    if (
      keep.has(version) ||
      references.some((reference) => prefixes.some((prefix) => reference.includes(prefix)))
    ) {
      continue;
    }
    const target = path.join(versionsDir, `${PINNED_RUNTIME_PRUNED_PREFIX}${version}`);
    // Renaming first means an interrupted removal never leaves a partial tree that still carries
    // its sentinel and would pass for a complete install.
    yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.andThen(fs.rename(versionDir, target)),
      Effect.andThen(Effect.sync(() => pruned.add(target))),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove an unused t3 runtime.", { version, cause }),
      ),
    );
  }
  return pruned;
});

/**
 * Keep runtimes named by callers, service state, running processes, launchers, or references,
 * and anything published within an hour. Only prune completed runtimes; leave staging
 * directories, symlinks, and unexpected entries untouched.
 */
export const prunePinnedRuntimes = Effect.fn("cloud.pinned_runtime.prune")(function* (input: {
  readonly baseDir: string;
  readonly keep: ReadonlyArray<string>;
  readonly references?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Only selection and the renames race an install; deleting renamed trees can take a while.
  const pruned = yield* pinnedRuntimeInstallLock.withPermit(
    selectUnusedRuntimes({ ...input, references: input.references ?? [] }),
  );
  const removed: Array<string> = [];
  for (const target of pruned) {
    yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.andThen(
        Effect.sync(() =>
          removed.push(path.basename(target).slice(PINNED_RUNTIME_PRUNED_PREFIX.length)),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove an unused t3 runtime.", { target, cause }),
      ),
    );
  }
  return removed;
});
