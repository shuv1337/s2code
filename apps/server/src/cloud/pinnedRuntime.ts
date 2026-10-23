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

const PINNED_RUNTIME_DIR = "runtime";
const PINNED_RUNTIME_INSTALL_TIMEOUT = Duration.minutes(10);
const PINNED_RUNTIME_ARCHIVE_FILE = "t3-runtime-archive";
// Boot-service setup and remote update can construct separate layers. Serialize
// the complete install transaction across every caller in this process.
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

/**
 * The sentinel is written only after extraction and validation succeed; checking the entry file
 * alone is not enough, since tar writes the executable before the last native package and a
 * killed install leaves a plausible-looking but broken tree behind.
 */

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
  // The install lock is held for the whole transaction, so a stalled download
  // must fail rather than block every other caller.
  return yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(
      Effect.fn(function* (response) {
        if (onProgress === undefined) return new Uint8Array(yield* response.arrayBuffer);
        const length = Number(response.headers["content-length"]);
        const total = Number.isFinite(length) && length > 0 ? length : undefined;
        let received = 0;
        onProgress({ stage: "download", received, total });
        const chunks = yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              received += chunk.byteLength;
              onProgress({ stage: "download", received, total });
            }),
          ),
          Stream.runCollect,
        );
        if (total === undefined && received > 0) {
          onProgress({ stage: "download", received, total: received });
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
    Effect.mapError((cause) => new PinnedRuntimeInstallError({ step, cause })),
    Effect.timeoutOrElse({
      duration: PINNED_RUNTIME_INSTALL_TIMEOUT,
      orElse: () => Effect.fail(new PinnedRuntimeInstallError({ step: `${step} (timed out)` })),
    }),
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
  // The archive wraps everything in one directory named after its stem;
  // strip it so the executable lands at <versionDir>/t3.
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
            ? fs.readFileString(paths.sentinelPath).pipe(Effect.map(Option.some))
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
