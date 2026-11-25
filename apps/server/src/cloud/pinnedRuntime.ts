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
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileNames,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  type CliArchivePlatformKey,
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
import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";
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
    httpStatus: Schema.optional(Schema.Number),
    downloadHost: Schema.optional(Schema.String),
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
  /** Reuse a cached runtime only while the release source still lists it, as a policy mirror does. */
  readonly requirePublishedRelease?: boolean;
  readonly onProgress?: (progress: PinnedRuntimeProgress) => void;
}

// GitHub release downloads intermittently answer 5xx during incidents; a retry usually lands.
const DOWNLOAD_RETRY = { times: 3, schedule: Schedule.exponential("2 seconds") } as const;

const isTransientDownloadFailure = (
  error: HttpClientError.HttpClientError | Cause.TimeoutError,
): boolean => {
  // A slow link stalls past the bound and then recovers; the retry resumes from the bytes held.
  if (error._tag === "TimeoutError") return true;
  // Body bytes are read raw, so a DecodeError is a body that failed after the host answered.
  if (error.reason._tag === "DecodeError") return true;
  const status = error.response?.status;
  return status !== undefined && (status >= 500 || status === 429 || status === 408);
};

const CONTENT_RANGE = /^bytes (\d+)-\d+\/(\d+|\*)$/;

const concatChunks = (chunks: ReadonlyArray<Uint8Array>, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const fetchReleaseAsset = Effect.fn("cloud.pinned_runtime.fetch_release_asset")(function* (
  httpClient: HttpClient.HttpClient,
  url: string,
  step: string,
  // Only a digest-checked asset resumes; anything else restarts at byte 0 on each retry.
  resume: boolean,
  onProgress?: (progress: PinnedRuntimeProgress) => void,
) {
  // Bytes from earlier attempts outlive the retry so a stalled download resumes with Range.
  let chunks: Array<Uint8Array> = [];
  let received = 0;
  // Bound stalls while holding the install lock, but allow transfers that keep
  // receiving bytes to finish regardless of their total duration.
  return yield* Effect.suspend(() => {
    if (!resume) {
      chunks = [];
      received = 0;
    }
    return httpClient.execute(
      received > 0
        ? HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("range", `bytes=${received}-`),
          )
        : HttpClientRequest.get(url),
    );
  }).pipe(
    // A resume answered 416 has nothing after the held bytes to send; the archive
    // checksum decides whether they are the whole file.
    Effect.filterOrElse(
      (response) => received > 0 && response.status === 416,
      HttpClientResponse.filterStatusOk,
    ),
    Effect.timeout(PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT),
    Effect.flatMap(
      Effect.fn(function* (response) {
        if (response.status === 416) return concatChunks(chunks, received);
        const contentRange =
          response.status === 206
            ? CONTENT_RANGE.exec(response.headers["content-range"] ?? "")
            : null;
        if (response.status === 206 && Number(contentRange?.[1]) !== received) {
          chunks = [];
          received = 0;
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: response.request,
              response,
              description: "partial content does not resume the bytes already received",
            }),
          });
        }
        if (contentRange === null) {
          chunks = [];
          received = 0;
        }
        const length = Number(
          contentRange === null ? response.headers["content-length"] : contentRange[2],
        );
        const total = Number.isFinite(length) && length > 0 ? length : undefined;
        onProgress?.({ stage: "download", received, total });
        const attemptStart = received;
        yield* response.stream.pipe(
          Stream.timeoutOrElse({
            duration: PINNED_RUNTIME_DOWNLOAD_STALL_TIMEOUT,
            orElse: () => Stream.fail(new Cause.TimeoutError()),
          }),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
              received += chunk.byteLength;
              onProgress?.({ stage: "download", received, total });
            }),
          ),
        );
        // A server may end a 206 before the declared total; a retry asks for the rest.
        if (
          resume &&
          contentRange !== null &&
          total !== undefined &&
          received > attemptStart &&
          received < total
        ) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.DecodeError({
              request: response.request,
              response,
              description: "partial content ended before the declared total",
            }),
          });
        }
        if (total === undefined && received > 0) {
          onProgress?.({ stage: "download", received, total: received });
        }
        return concatChunks(chunks, received);
      }),
    ),
    Effect.retry({ ...DOWNLOAD_RETRY, while: isTransientDownloadFailure }),
    Effect.mapError(
      (cause) =>
        new PinnedRuntimeInstallError({
          step: cause._tag === "TimeoutError" ? `${step} (timed out)` : step,
          httpStatus:
            HttpClientError.isHttpClientError(cause) && cause.reason._tag === "StatusCodeError"
              ? cause.reason.response.status
              : undefined,
          downloadHost: URL.parse(
            HttpClientError.isHttpClientError(cause) ? cause.request.url : url,
          )?.host,
          cause,
        }),
    ),
  );
});

const downloadArchive = Effect.fn("cloud.pinned_runtime.download_archive")(function* (
  input: PinnedRuntimeInstallInput,
) {
  const platformKey = cliArchivePlatformKey(input.platform, input.arch);
  if (platformKey === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
    });
  }
  const httpClient = input.httpClient;
  input.onProgress?.({ stage: "download", received: 0, total: undefined });
  const { fileName, expected } = yield* publishedArchive(input, platformKey);
  const archive = yield* fetchReleaseAsset(
    httpClient,
    cliReleaseAssetUrl(input.version, fileName, input.releaseBaseUrl),
    "downloading the t3 release archive",
    true,
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
  return archive;
});

const installFromArchive = Effect.fn("cloud.pinned_runtime.install_archive")(function* (
  input: PinnedRuntimeInstallInput,
  stagingDir: string,
  archive: Uint8Array,
) {
  const { fs, path } = input;
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

/** The release's archive for this machine and its checksum; fails when the release lists none. */
const publishedArchive = Effect.fn("cloud.pinned_runtime.published_archive")(function* (
  input: PinnedRuntimeInstallInput,
  platformKey: CliArchivePlatformKey,
) {
  const fileNames = cliArchiveFileNames(input.version, platformKey);
  const checksums = parseChecksums(
    new TextDecoder().decode(
      yield* fetchReleaseAsset(
        input.httpClient,
        cliReleaseAssetUrl(input.version, CLI_RELEASE_CHECKSUMS_FILE, input.releaseBaseUrl),
        "downloading the t3 release checksums",
        false,
      ),
    ),
  );
  const fileName = fileNames.find((name) => checksums.has(name));
  const expected = fileName === undefined ? undefined : checksums.get(fileName);
  if (fileName === undefined || expected === undefined) {
    return yield* new PinnedRuntimeInstallError({
      step: `finding ${fileNames[0]} in the t3 release checksums`,
    });
  }
  return { fileName, expected };
});

const isPinnedRuntimeInstallError = Schema.is(PinnedRuntimeInstallError);

/** Whether an install failed because the release source does not publish the version for this machine. */
export const isUnpublishedRelease = (error: unknown): error is PinnedRuntimeInstallError =>
  isPinnedRuntimeInstallError(error) &&
  (error.step.startsWith("finding ") ||
    (error.step.startsWith("downloading the t3 release") &&
      HttpClientError.isHttpClientError(error.cause) &&
      error.cause.response?.status === 404));

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
    if (input.requirePublishedRelease === true) {
      const platformKey = cliArchivePlatformKey(input.platform, input.arch);
      if (platformKey === undefined) {
        return yield* new PinnedRuntimeInstallError({
          step: `selecting a t3 release archive for ${input.platform}-${input.arch}`,
        });
      }
      yield* publishedArchive(input, platformKey);
    }
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
  // Downloads are buffered in memory and can take hours; staging only once they finish keeps a
  // staging directory's age a sign of abandonment for prunes in other processes.
  const archive = yield* downloadArchive(input);
  const stagingDir = yield* fs
    .makeTempDirectory({
      directory: versionsDir,
      prefix: PINNED_RUNTIME_STAGING_PREFIX,
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
    yield* installFromArchive(input, stagingDir, archive);

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

const PINNED_RUNTIME_STAGING_PREFIX = ".staging-";
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

/**
 * Starts on a fresh line whatever the file ends with when the append lands: another process's
 * append may have been cut short since this one read the file. Readers skip the blank lines.
 */
const launcherRecords = (launchers: ReadonlyArray<string>) =>
  `\n${launchers.map((launcher) => `${launcher}\n`).join("")}`;

export function ownedLauncherNames(
  version: string,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const suffix = platform === "win32" ? ".cmd" : "";
  const names = new Set([
    resolveChannelIdentity(version).executableName,
    resolveLegacyChannelIdentity(version).executableName,
    "s2code",
    "shuv2code",
    "s2c",
    "t3",
  ]);
  return Array.from(names, (name) => `${name}${suffix}`);
}

export function launcherOwnsVersionsDir(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
  platform?: NodeJS.Platform,
): boolean {
  const normalize = (value: string) =>
    platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(versionsDir), normalize(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Whether `candidate` resolves inside this home's `runtime/versions` tree.
 * When the target exists, its resolved `realPath` decides ownership so a symlinked version dir
 * or junction pointing into another home is never treated as owned.
 */
const MAX_CANONICALIZE_HOPS = 32;

/** Joins a POSIX symlink/script target onto `dir` without lexically collapsing `..` before symlinks are followed. */
export function joinRawPosixPath(dir: string, target: string): string {
  if (target.startsWith("/")) return target;
  return dir === "/" ? `/${target}` : `${dir.replace(/\/+$/, "")}/${target}`;
}

function collapseWin32Segments(segments: ReadonlyArray<string>): Array<string> {
  const collapsed: Array<string> = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      collapsed.pop();
    } else {
      collapsed.push(segment);
    }
  }
  return collapsed;
}

function splitAbsoluteRoot(
  raw: string,
  sep: string,
  windows: boolean,
):
  | {
      readonly root: string;
      readonly segments: Array<string>;
      readonly trailingSlash: boolean;
    }
  | undefined {
  if (windows) {
    const isInvalidUncComponent = (server: string, share: string) =>
      server === "." || server === ".." || server === "?" || share === "." || share === "..";
    if (raw.startsWith("\\\\?\\")) {
      const restAfterPrefix = raw.slice(4);
      if (/^[a-zA-Z]:\\/.test(restAfterPrefix)) {
        const rest = restAfterPrefix.slice(3);
        const rawSegments = rest.length === 0 ? [] : rest.split("\\");
        if (rawSegments.some((segment) => segment === "." || segment === "..")) {
          return undefined;
        }
        return {
          root: `${restAfterPrefix.slice(0, 2)}${sep}`,
          segments: rawSegments,
          trailingSlash: rest.length > 0 && restAfterPrefix.endsWith("\\"),
        };
      }
      const verbatimUnc = /^UNC\\([^\\]+)\\([^\\]+)(?:\\|$)/i.exec(restAfterPrefix);
      if (verbatimUnc !== null) {
        const server = verbatimUnc[1]!;
        const share = verbatimUnc[2]!;
        if (isInvalidUncComponent(server, share)) return undefined;
        const rest = restAfterPrefix.slice(verbatimUnc[0].length);
        const rawSegments = rest.length === 0 ? [] : rest.split("\\");
        if (rawSegments.some((segment) => segment === "." || segment === "..")) {
          return undefined;
        }
        return {
          root: `${sep}${sep}${server}${sep}${share}${sep}`,
          segments: rawSegments,
          trailingSlash: rest.length > 0 && restAfterPrefix.endsWith("\\"),
        };
      }
      return undefined;
    }
    if (raw.startsWith("\\\\.\\") || raw.startsWith("//?/") || raw.startsWith("//./")) {
      return undefined;
    }
    if (/^[a-zA-Z]:[\\/]/.test(raw)) {
      const rest = raw.slice(3);
      const rawSegments = rest.length === 0 ? [] : rest.split(/[\\/]/);
      return {
        root: `${raw.slice(0, 2)}${sep}`,
        segments: collapseWin32Segments(rawSegments),
        trailingSlash: rest.length > 0 && /[\\/]$/.test(raw),
      };
    }
    const unc = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(raw);
    if (unc !== null) {
      const server = unc[1]!;
      const share = unc[2]!;
      if (isInvalidUncComponent(server, share)) return undefined;
      const rest = raw.slice(unc[0].length);
      const rawSegments = rest.length === 0 ? [] : rest.split(/[\\/]/);
      return {
        root: `${sep}${sep}${server}${sep}${share}${sep}`,
        segments: collapseWin32Segments(rawSegments),
        trailingSlash: rest.length > 0 && /[\\/]$/.test(raw),
      };
    }
  }
  if (!raw.startsWith("/")) return undefined;
  const rest = raw.slice(1);
  const rawSegments = rest.length === 0 ? [] : rest.split(windows ? /[\\/]/ : "/");
  return {
    root: "/",
    segments: windows ? collapseWin32Segments(rawSegments) : rawSegments,
    trailingSlash: rest.length > 0 && (windows ? /[\\/]$/.test(raw) : raw.endsWith("/")),
  };
}

function joinRootSegments(root: string, segments: ReadonlyArray<string>, sep: string): string {
  return segments.length === 0 ? root : `${root}${segments.join(sep)}`;
}

/**
 * Canonicalizes an absolute path left-to-right without calling Node's `fs.realpath` (which
 * lexically collapses `..` before following symlinks). Follows symlinks/junctions even when tail
 * components are missing, bounded by {@link MAX_CANONICALIZE_HOPS}.
 */
export const canonicalizeLauncherPath = Effect.fn(
  "cloud.pinned_runtime.canonicalize_launcher_path",
)(function* (input: {
  readonly target: string;
  readonly platform: NodeJS.Platform;
  readonly followLastSymlink?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = input.platform === "win32";
  const followLastSymlink = input.followLastSymlink ?? true;
  const initial = splitAbsoluteRoot(input.target, path.sep, windows);
  if (initial === undefined) return undefined;

  const readLinkStatus = (file: string) =>
    fs.readLink(file).pipe(
      Effect.asSome,
      Effect.catch((error) =>
        Effect.succeed(
          error.reason._tag === "NotFound" ||
            (error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EINVAL"
            ? Option.none<string>()
            : undefined,
        ),
      ),
    );

  let root = initial.root;
  let trailingSlash = initial.trailingSlash;
  const queue = [...initial.segments];
  const prefix: Array<string> = [];
  let hops = 0;
  let missing = false;
  let lastType: FileSystem.File.Type | undefined;

  while (queue.length > 0) {
    const segment = queue.shift()!;
    if (segment === "") continue;
    if (segment === ".") {
      // On POSIX, `file/.` fails with ENOTDIR just like `file/`; decline when not a directory.
      if (missing || (lastType !== undefined && lastType !== "Directory")) return undefined;
      continue;
    }
    const hasMore = queue.some((rest) => rest !== "");
    if (segment === "..") {
      // `..` cannot safely traverse through a missing component or non-directory; decline ownership.
      if (missing || (lastType !== undefined && lastType !== "Directory")) return undefined;
      prefix.pop();
      lastType = "Directory";
      continue;
    }
    if (missing) {
      prefix.push(segment);
      lastType = undefined;
      continue;
    }
    const nextPath = joinRootSegments(root, [...prefix, segment], path.sep);
    if (hasMore || followLastSymlink) {
      const link = yield* readLinkStatus(nextPath);
      if (link === undefined) return undefined;
      if (Option.isSome(link)) {
        hops += 1;
        if (hops > MAX_CANONICALIZE_HOPS) return undefined;
        const linkRaw = link.value;
        const linkRoot = splitAbsoluteRoot(linkRaw, path.sep, windows);
        if (linkRoot !== undefined) {
          root = linkRoot.root;
          prefix.length = 0;
          if (!hasMore && linkRoot.trailingSlash) trailingSlash = true;
          queue.unshift(...linkRoot.segments);
        } else {
          const relSegments = linkRaw.split(windows ? /[\\/]/ : "/");
          if (windows && (linkRaw.startsWith("\\\\?\\") || relSegments.includes(".."))) {
            return undefined;
          }
          const linkHasTrailing = windows ? /[\\/]$/.test(linkRaw) : linkRaw.endsWith("/");
          if (!hasMore && linkHasTrailing) trailingSlash = true;
          queue.unshift(...relSegments);
        }
        lastType = undefined;
        continue;
      }
    }
    const info = yield* fs.stat(nextPath).pipe(
      Effect.asSome,
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? Option.none() : undefined),
      ),
    );
    if (info === undefined) return undefined;
    if (Option.isNone(info)) {
      prefix.push(segment);
      missing = true;
      lastType = undefined;
      continue;
    }
    if (info.value.type !== "Directory" && hasMore) {
      return undefined;
    }
    prefix.push(segment);
    lastType = info.value.type;
  }

  // A trailing slash on an existing non-directory is invalid (`ENOTDIR`); decline safely.
  if (trailingSlash && lastType !== undefined && lastType !== "Directory") {
    return undefined;
  }
  return joinRootSegments(root, prefix, path.sep);
});

export const isOwnedVersionsTarget = Effect.fn("cloud.pinned_runtime.is_owned_versions_target")(
  function* (input: {
    readonly versionsDir: string;
    readonly realVersionsDir: string;
    readonly candidate: string;
    readonly platform: NodeJS.Platform;
  }) {
    const path = yield* Path.Path;
    const canonicalVersionsDir = yield* canonicalizeLauncherPath({
      target: input.realVersionsDir,
      platform: input.platform,
    });
    const canonicalCandidate = yield* canonicalizeLauncherPath({
      target: input.candidate,
      platform: input.platform,
    });
    if (canonicalVersionsDir === undefined || canonicalCandidate === undefined) return false;
    return launcherOwnsVersionsDir(path, canonicalVersionsDir, canonicalCandidate, input.platform);
  },
);

export const readPinnedRuntimeLaunchers = Effect.fn("cloud.pinned_runtime.read_launchers")(
  function* (baseDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const launchersFile = path.join(baseDir, PINNED_RUNTIME_DIR, PINNED_RUNTIME_LAUNCHERS_FILE);
    const recorded = yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => ""));
    return recorded
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
  },
);

/** Node preserves argv0's spelling; resolve bare names on PATH to find the launcher symlink. */
export const resolveLauncherPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const invokedAs = yield* HostProcess.InvokedAs;
  const cwd = yield* HostProcess.WorkingDirectory;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  if (invokedAs.includes("/") || invokedAs.includes("\\")) {
    return path.resolve(cwd, invokedAs);
  }
  const delimiter = platform === "win32" ? ";" : ":";
  const searchPath = environment["PATH"] ?? "";
  for (const directory of searchPath.split(delimiter)) {
    // POSIX shells search the working directory for an empty entry of a nonempty PATH.
    if (directory.length === 0 && (platform === "win32" || searchPath.length === 0)) continue;
    const candidate = path.resolve(cwd, directory || ".", invokedAs);
    const info = yield* fs.stat(candidate).pipe(Effect.option);
    // Like the shell, pass over directories and non-executable files named the same.
    if (
      Option.isSome(info) &&
      info.value.type === "File" &&
      (platform === "win32" || (info.value.mode & 0o111) !== 0)
    ) {
      return candidate;
    }
  }
  return undefined;
});

/**
 * `t3 update` repoints the launcher it was started through, which may be on neither PATH nor the
 * default bin dir. Unrecorded, the next prune would remove the runtime it now points at.
 */
export const recordPinnedRuntimeLauncher = Effect.fn("cloud.pinned_runtime.record_launcher")(
  function* (input: { readonly baseDir: string; readonly launcher: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const launchersFile = path.join(
      input.baseDir,
      PINNED_RUNTIME_DIR,
      PINNED_RUNTIME_LAUNCHERS_FILE,
    );
    // Prune may run in another process, such as the service, whose working directory differs.
    const launcher = path.resolve(input.launcher);
    const recorded = yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => ""));
    if (recorded.split(/\r?\n/).includes(launcher)) return;
    yield* fs.makeDirectory(path.dirname(launchersFile), { recursive: true });
    yield* fs.writeFileString(launchersFile, launcherRecords([launcher]), { flag: "a" });
  },
);

/** Whether `candidate` is a version's own executable, `<versionsDir>/<version>/t3[.exe]`. */
export function isVersionExecutable(
  path: Path.Path,
  versionsDir: string,
  candidate: string,
): boolean {
  const relative = path.relative(versionsDir, path.resolve(candidate));
  // On another Windows drive, relative() returns the absolute path, like `D:\t3.exe`.
  return !path.isAbsolute(relative) && /^(?!\.\.)[^\\/]+[\\/]t3(?:\.exe)?$/i.test(relative);
}

/** The executable a `t3.cmd` shim written by the install script or `t3 update` runs.
 * @public Upstream's `t3 update` and `t3 uninstall` call this; the nightly-only fork has no caller. */
export const windowsShimTarget = (contents: string) => /^"([^"]+)"/m.exec(contents)?.[1];

/** Like {@link windowsShimTarget}, but only for a shim exactly as written; never a user's wrapper. */
export const generatedWindowsShimTarget = (contents: string) =>
  /^@echo off\r?\n"([^"]+)" %\*\s*$/.exec(contents)?.[1];

/** Target `.cmd` of an owned Windows forwarder shim written by `install.ps1` or `update`. */
export const generatedWindowsForwarderTarget = (contents: string): string | undefined => {
  const trimmed = contents.replace(/(?:\r?\n)+$/, "");
  const direct = /^@echo off\r?\n(?:call )?"([^"]+\.cmd)" %\*$/i.exec(trimmed)?.[1];
  if (direct !== undefined) return direct;
  return /^@echo off\r?\nsetlocal DisableDelayedExpansion\r?\nset "s2_line="\r?\nfor \/f "usebackq skip=1 delims=" %%L in \("([^"]+\.cmd)"\) do set "s2_line=%%L"\r?\nif not defined s2_line exit \/b 1\r?\nset "s2_exe=%s2_line:~1,-4%"\r?\nif not defined s2_exe exit \/b 1\r?\nendlocal & "%s2_exe%" %\*\r?\nexit \/b %ERRORLEVEL%$/.exec(
    trimmed,
  )?.[1];
};

/**
 * The `t3` script the install scripts and `t3 update` write on macOS and Linux. Exec by absolute
 * path: through a symlink, argv0 is the link, and the Cursor SDK looks for its helpers beside it.
 * When `exportLine` is provided, preserves a legacy 3-line wrapper's `export S2CODE_HOME=...` line.
 */
export const posixLauncherScript = (executable: string, exportLine?: string) =>
  exportLine === undefined
    ? `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`
    : `#!/bin/sh\n${exportLine}\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;

function expandLegacyPosixPath(raw: string, homeDir: string | undefined): string | undefined {
  if (raw.startsWith("$HOME/")) {
    const trimmedHome = homeDir?.trim();
    if (!trimmedHome) return undefined;
    const rel = raw.slice("$HOME/".length);
    if (rel.length === 0 || /["`\\$\r\n]/.test(rel)) return undefined;
    return `${trimmedHome.replace(/\/+$/, "")}/${rel}`;
  }
  if (raw.startsWith("/") && !/["`\\$\r\n]/.test(raw)) {
    return raw;
  }
  return undefined;
}

function parseLegacyHomeExportLine(line: string, homeDir: string | undefined): string | undefined {
  const nested =
    /^export S2CODE_HOME="\$\{S2CODE_HOME:-\$\{SHUV2CODE_HOME:-([^}"`\\;\r\n]+)\}\}"$/.exec(
      line,
    )?.[1];
  if (nested !== undefined) return expandLegacyPosixPath(nested, homeDir);
  const direct = /^export (S2CODE_HOME|SHUV2CODE_HOME)="\$\{\1:-([^}"`\\;\r\n]+)\}"$/.exec(line);
  if (direct?.[2] !== undefined) return expandLegacyPosixPath(direct[2], homeDir);
  return undefined;
}

function parsePosixExecLine(line: string, homeDir: string | undefined): string | undefined {
  const singleQuoted = /^exec '((?:[^']|'\\'')*)' "\$@"$/.exec(line)?.[1];
  if (singleQuoted !== undefined) {
    return singleQuoted.replaceAll("'\\''", "'");
  }
  const doubleQuoted = /^exec "([^"`\\;\r\n]+)" "\$@"$/.exec(line)?.[1];
  if (doubleQuoted !== undefined) {
    return expandLegacyPosixPath(doubleQuoted, homeDir);
  }
  return undefined;
}

/** Parses an unedited 2-line {@link posixLauncherScript} or 3-line legacy home-scoped wrapper; never a user's wrapper. */
export const readPosixLauncher = Effect.fn("cloud.pinned_runtime.read_posix_launcher")(function* (
  launcher: string,
  options?: { readonly baseDir?: string | undefined },
) {
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const homeDir = environment["HOME"]?.trim() || (yield* HostProcess.HomeDirectory);
  // Stat first so a runtime binary found the same way is never read whole.
  const info = yield* fs.stat(launcher).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File" || info.value.size > 4096n) {
    return undefined;
  }
  const contents = yield* fs.readFileString(launcher).pipe(Effect.option);
  if (Option.isNone(contents)) return undefined;
  const trimmed = contents.value.endsWith("\n") ? contents.value.slice(0, -1) : contents.value;
  const lines = trimmed.split("\n");
  if (lines[0] !== "#!/bin/sh") return undefined;
  if (lines.length === 2 && contents.value.endsWith("\n")) {
    const quoted = /^exec '((?:[^']|'\\'')*)' "\$@"$/.exec(lines[1]!)?.[1];
    if (quoted === undefined) return undefined;
    return { target: quoted.replaceAll("'\\''", "'") };
  }
  if (lines.length === 3) {
    const exportHome = parseLegacyHomeExportLine(lines[1]!, homeDir);
    if (exportHome === undefined) return undefined;
    const target = parsePosixExecLine(lines[2]!, homeDir);
    if (target === undefined) return undefined;
    const normalizePosix = (value: string) => value.replace(/\/+$/, "");
    const normalizedExportHome = normalizePosix(exportHome);
    const resolvedExportHome = yield* fs
      .realPath(exportHome)
      .pipe(Effect.orElseSucceed(() => normalizedExportHome));
    if (options?.baseDir !== undefined) {
      const normalizedBaseDir = normalizePosix(options.baseDir);
      const resolvedBaseDir = yield* fs
        .realPath(options.baseDir)
        .pipe(Effect.orElseSucceed(() => normalizedBaseDir));
      if (
        normalizedExportHome !== normalizedBaseDir &&
        normalizePosix(resolvedExportHome) !== normalizePosix(resolvedBaseDir)
      ) {
        return undefined;
      }
    }
    const resolvedTarget = yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => target));
    const matchesHomeVersions =
      target.startsWith(`${normalizedExportHome}/runtime/versions/`) ||
      resolvedTarget.startsWith(`${normalizePosix(resolvedExportHome)}/runtime/versions/`);
    if (!matchesHomeVersions) return undefined;
    return { target, exportLine: lines[1]! };
  }
  return undefined;
});

/** The executable a script matched by {@link readPosixLauncher} runs; never a user's wrapper. */
export const readPosixLauncherTarget = Effect.fn("cloud.pinned_runtime.read_posix_launcher_target")(
  function* (launcher: string, options?: { readonly baseDir?: string | undefined }) {
    return (yield* readPosixLauncher(launcher, options))?.target;
  },
);

/**
 * The `t3` this executable was started through on macOS or Linux: a legacy symlink into this
 * home's runtime/versions, or, since a script execs the executable and argv0 names it, an unedited
 * {@link posixLauncherScript} that runs it.
 */
export const findPosixLauncher = Effect.fn("cloud.pinned_runtime.find_posix_launcher")(
  function* (input: {
    readonly launchedAs: string;
    readonly versionsDir: string;
    readonly version?: string | undefined;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const names = ownedLauncherNames(input.version ?? packageJson.version, "linux");
    const canonicalPath = (file: string) =>
      canonicalizeLauncherPath({ target: file, platform: "linux" });
    const realVersionsDir = (yield* canonicalPath(input.versionsDir)) ?? input.versionsDir;
    const ownsTarget = (candidate: string) =>
      isOwnedVersionsTarget({
        versionsDir: input.versionsDir,
        realVersionsDir,
        candidate,
        platform: "linux",
      });
    const baseDir = path.dirname(path.dirname(input.versionsDir));
    const linkTarget = yield* fs.readLink(input.launchedAs).pipe(Effect.option);
    if (Option.isSome(linkTarget)) {
      const parentReal =
        (yield* canonicalPath(path.dirname(input.launchedAs))) ?? path.dirname(input.launchedAs);
      const unresolved = joinRawPosixPath(parentReal, linkTarget.value);
      if (yield* ownsTarget(unresolved)) return input.launchedAs;
      // Symlink alias pointing to an owned POSIX launcher script (e.g. ~/.local/bin/s2code -> <baseDir>/bin/shuv2code).
      const target = (yield* canonicalPath(unresolved)) ?? unresolved;
      const scriptTarget = yield* readPosixLauncherTarget(target, { baseDir });
      if (scriptTarget !== undefined && (yield* ownsTarget(scriptTarget))) return target;
      return undefined;
    }
    const executable = yield* canonicalPath(input.launchedAs);
    if (executable === undefined || !isVersionExecutable(path, realVersionsDir, executable)) {
      return undefined;
    }
    const recorded = yield* readPinnedRuntimeLaunchers(baseDir);
    const cwd = yield* HostProcess.WorkingDirectory;
    const home = yield* HostProcess.HomeDirectory;
    const searchPath = environment["PATH"] ?? "";
    const configuredInstallDirs = [
      environment["S2CODE_INSTALL_BIN_DIR"]?.trim(),
      environment["SHUV2CODE_INSTALL_BIN_DIR"]?.trim(),
      environment["T3CODE_INSTALL_BIN_DIR"]?.trim(),
    ].filter((entry): entry is string => entry !== undefined && entry.length > 0);
    const installDirs =
      configuredInstallDirs.length > 0 ? configuredInstallDirs : [path.join(home, ".local", "bin")];
    const candidates = [
      // PATH first, resolved like the shell does: it decides which launcher the user runs. An empty
      // entry of a nonempty PATH is the working directory; an empty PATH searches nothing.
      ...(searchPath.length === 0 ? [] : searchPath.split(":")).flatMap((directory) =>
        names.map((name) => path.resolve(cwd, directory || ".", name)),
      ),
      ...installDirs.flatMap((directory) => names.map((name) => path.join(directory, name))),
      ...names.map((name) => path.join(baseDir, "bin", name)),
      ...recorded,
    ].filter((candidate) => path.isAbsolute(candidate));
    for (const candidate of candidates) {
      // The script itself, so an alias that links to it keeps working.
      const script = yield* canonicalPath(candidate);
      if (script === undefined) continue;
      // Like the shell, pass over a script nobody can execute.
      const info = yield* fs.stat(script).pipe(Effect.option);
      if (Option.isNone(info) || (info.value.mode & 0o111) === 0) continue;
      const target = yield* readPosixLauncherTarget(script, { baseDir });
      if (target !== undefined && (yield* canonicalPath(target)) === executable) return script;
    }
    return undefined;
  },
);

/** Writes {@link posixLauncherScript} at `launcher` in one rename, replacing a legacy symlink rather than writing through it. */
export const writePosixLauncher = Effect.fn("cloud.pinned_runtime.write_posix_launcher")(
  function* (input: {
    readonly launcher: string;
    readonly executable: string;
    /** Fail instead of replacing a file that is there, even one created after the caller looked. */
    readonly exclusive: boolean;
    readonly exportLine?: string | undefined;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staging = yield* fs.makeTempFileScoped({
      directory: path.dirname(input.launcher),
      prefix: ".t3-",
    });
    yield* fs.writeFileString(staging, posixLauncherScript(input.executable, input.exportLine));
    yield* fs.chmod(staging, 0o755);
    yield* input.exclusive ? fs.link(staging, input.launcher) : fs.rename(staging, input.launcher);
  },
  Effect.scoped,
);

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
  const inVersionsDir = (candidate: string) =>
    launcherOwnsVersionsDir(path, versionsDir, candidate) ||
    launcherOwnsVersionsDir(path, realVersionsDir, candidate);
  const unrecorded: Array<string> = [];
  const targets: Array<string> = [];
  for (const launcher of [...recorded, ...found]) {
    const resolved =
      platform === "win32"
        ? yield* fs.readFileString(launcher).pipe(
            Effect.map(windowsShimTarget),
            Effect.orElseSucceed(() => undefined),
          )
        : // Fully resolved, through chained links and a symlinked T3 home alike.
          yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => undefined));
    if (resolved === undefined) continue;
    const scriptTarget =
      platform === "win32" ? undefined : yield* readPosixLauncherTarget(resolved);
    const target =
      scriptTarget === undefined
        ? resolved
        : yield* fs.realPath(scriptTarget).pipe(Effect.orElseSucceed(() => scriptTarget));
    // A runtime's own entry, on the macOS service PATH or recorded by an earlier prune, is no launcher.
    // It is named as `versions/<version>/t3`, and neither it nor its directory is a link.
    const entryDir = path.dirname(path.resolve(launcher));
    const parent = path.dirname(entryDir);
    if (
      platform !== "win32" &&
      scriptTarget === undefined &&
      (parent === versionsDir || parent === realVersionsDir) &&
      target === path.join(realVersionsDir, path.basename(entryDir), path.basename(launcher))
    ) {
      continue;
    }
    targets.push(target);
    if (inVersionsDir(target) && !recorded.includes(launcher) && !unrecorded.includes(launcher)) {
      unrecorded.push(launcher);
    }
  }
  if (unrecorded.length > 0) {
    yield* fs
      .writeFileString(launchersFile, launcherRecords(unrecorded), { flag: "a" })
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
            command: windowsPowerShellPath(yield* HostProcess.Environment),
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
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
    if (version.startsWith(PINNED_RUNTIME_STAGING_PREFIX)) {
      // A crashed or interrupted install leaves its staging directory behind.
      const stagingDir = path.join(versionsDir, version);
      const modifiedAt = yield* fs.stat(stagingDir).pipe(
        Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
        Effect.orElseSucceed(() => undefined),
      );
      if (modifiedAt !== undefined && modifiedAt < settledBefore) pruned.add(stagingDir);
      continue;
    }
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
      // A committed update never returns to the runtime it replaced.
      if (state.update.status !== "committed") keep.add(state.update.fromVersion);
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
 * and anything published within an hour. Only prune completed runtimes and staging directories
 * untouched for an hour; leave symlinks and unexpected entries untouched.
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
    const name = path.basename(target);
    yield* fs.remove(target, { recursive: true, force: true }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (name.startsWith(PINNED_RUNTIME_PRUNED_PREFIX)) {
            removed.push(name.slice(PINNED_RUNTIME_PRUNED_PREFIX.length));
          }
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not remove an unused t3 runtime.", { target, cause }),
      ),
    );
  }
  return removed;
});
