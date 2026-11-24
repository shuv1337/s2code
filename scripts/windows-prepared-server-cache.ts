// @effect-diagnostics nodeBuiltinImport:off -- Uses node:fs/promises lstat and readdir withFileTypes to reject symlinks and subdirectories.
import * as NodeFSP from "node:fs/promises";

import { statFile } from "@electron/asar";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT = 256;

const CACHE_FILE_PATTERN = /^[a-f0-9]{8}$/;
const CACHE_MODULE_PATTERN = /^server\.asar\/apps\/server\/dist\/([^/\\]+\.mjs)$/;

const PreparedServerCacheManifest = Schema.Struct({
  format: Schema.Literal(1),
  runtime: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      module: Schema.String,
      file: Schema.String,
    }),
  ),
});

const decodePreparedServerCacheManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PreparedServerCacheManifest),
);

const WindowsPreparedServerCacheReason = Schema.Literals([
  "manifest-invalid",
  "contents-mismatch",
  "entry-limit-exceeded",
]);

export class WindowsPreparedServerCacheError extends Schema.TaggedError<WindowsPreparedServerCacheError>()(
  "WindowsPreparedServerCacheError",
  {
    reason: WindowsPreparedServerCacheReason,
    cacheDir: Schema.String,
    unexpectedFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    missingFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    entryCount: Schema.optionalKey(Schema.Int),
    entryLimit: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "entry-limit-exceeded") {
      return `Prepared server cache at ${this.cacheDir} contains ${String(this.entryCount)} entries; expected at most ${String(this.entryLimit)}.`;
    }
    if (this.reason === "contents-mismatch") {
      const details: string[] = [];
      if (this.missingFiles !== undefined && this.missingFiles.length > 0) {
        details.push(`missing: ${this.missingFiles.join(", ")}`);
      }
      if (this.unexpectedFiles !== undefined && this.unexpectedFiles.length > 0) {
        details.push(`unexpected: ${this.unexpectedFiles.join(", ")}`);
      }
      const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
      return `Prepared server cache at ${this.cacheDir} does not match manifest.json${suffix}.`;
    }
    if (this.missingFiles !== undefined && this.missingFiles.length > 0) {
      return `Prepared server cache at ${this.cacheDir} is missing ${this.missingFiles.join(", ")}.`;
    }
    const detail =
      this.cause instanceof Error && this.cause.message.length > 0 ? `: ${this.cause.message}` : "";
    return `Prepared server cache at ${this.cacheDir} has an invalid manifest${detail}.`;
  }
}

export const validateWindowsPreparedServerCache = Effect.fn(
  "desktopArtifact.validateWindowsPreparedServerCache",
)(function* (input: {
  readonly resourcesDir: string;
  readonly asarPath: string;
  readonly entryLimit?: number;
}) {
  const path = yield* Path.Path;
  const entryLimit = input.entryLimit ?? WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT;
  const cacheDir = path.join(input.resourcesDir, "server-compile-cache");

  const cacheStat = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await NodeFSP.lstat(cacheDir);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
    },
    catch: (cause) =>
      new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause,
      }),
  });

  if (cacheStat === null) {
    yield* Effect.log(`[desktop-artifact] No prepared server cache found at ${cacheDir}.`);
    return { present: false, entryCount: 0, fileCount: 0 } as const;
  }

  if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) {
    return yield* new WindowsPreparedServerCacheError({
      reason: "manifest-invalid",
      cacheDir,
      cause: new Error("server-compile-cache must be a regular directory"),
    });
  }

  const dirEntries = yield* Effect.tryPromise({
    try: () => NodeFSP.readdir(cacheDir, { withFileTypes: true }),
    catch: (cause) =>
      new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause,
      }),
  });

  const unexpectedNonFiles: string[] = [];
  const diskFiles = new Set<string>();
  let hasManifest = false;

  for (const entry of dirEntries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      unexpectedNonFiles.push(entry.name);
      continue;
    }
    if (entry.name === "manifest.json") {
      hasManifest = true;
      continue;
    }
    diskFiles.add(entry.name);
  }

  if (unexpectedNonFiles.length > 0) {
    return yield* new WindowsPreparedServerCacheError({
      reason: "contents-mismatch",
      cacheDir,
      unexpectedFiles: unexpectedNonFiles.sort(),
    });
  }

  if (!hasManifest) {
    return yield* new WindowsPreparedServerCacheError({
      reason: "manifest-invalid",
      cacheDir,
      missingFiles: ["manifest.json"],
    });
  }

  const manifestRaw = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(path.join(cacheDir, "manifest.json"), "utf8"),
    catch: (cause) =>
      new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause,
      }),
  });

  const manifest = yield* decodePreparedServerCacheManifest(manifestRaw).pipe(
    Effect.mapError(
      (cause) =>
        new WindowsPreparedServerCacheError({
          reason: "manifest-invalid",
          cacheDir,
          cause,
        }),
    ),
  );

  if (manifest.runtime.trim().length === 0) {
    return yield* new WindowsPreparedServerCacheError({
      reason: "manifest-invalid",
      cacheDir,
      cause: new Error("manifest runtime must be a non-empty string"),
    });
  }

  if (manifest.entries.length === 0) {
    return yield* new WindowsPreparedServerCacheError({
      reason: "manifest-invalid",
      cacheDir,
      cause: new Error("manifest entries must be non-empty"),
    });
  }

  const expectedFiles = new Set<string>();
  const seenModules = new Set<string>();
  const moduleFiles: string[] = [];

  for (const entry of manifest.entries) {
    if (!CACHE_FILE_PATTERN.test(entry.file)) {
      return yield* new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause: new Error(`Invalid prepared server cache file name: ${entry.file}`),
      });
    }
    const moduleMatch = CACHE_MODULE_PATTERN.exec(entry.module);
    const moduleFile = moduleMatch?.[1];
    if (moduleFile === undefined) {
      return yield* new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause: new Error(`Invalid prepared server cache module path: ${entry.module}`),
      });
    }
    if (expectedFiles.has(entry.file)) {
      return yield* new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause: new Error(`Duplicate prepared server cache file entry: ${entry.file}`),
      });
    }
    if (seenModules.has(entry.module)) {
      return yield* new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause: new Error(`Duplicate prepared server cache module entry: ${entry.module}`),
      });
    }
    expectedFiles.add(entry.file);
    seenModules.add(entry.module);
    moduleFiles.push(moduleFile);
  }

  if (manifest.entries.length > entryLimit) {
    return yield* new WindowsPreparedServerCacheError({
      reason: "entry-limit-exceeded",
      cacheDir,
      entryCount: manifest.entries.length,
      entryLimit,
    });
  }

  yield* Effect.try({
    try: () => {
      for (const moduleFile of moduleFiles) {
        // @electron/asar requires host separators even for archive entry names.
        const record = statFile(
          input.asarPath,
          path.join("apps", "server", "dist", moduleFile),
          false,
        );
        if ("files" in record || "link" in record) {
          throw new Error(
            `Prepared server cache module server.asar/apps/server/dist/${moduleFile} is not a regular file`,
          );
        }
      }
    },
    catch: (cause) =>
      new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause,
      }),
  });

  const missingFiles = [...expectedFiles].filter((file) => !diskFiles.has(file)).sort();
  const unexpectedFiles = [...diskFiles].filter((file) => !expectedFiles.has(file)).sort();

  if (missingFiles.length > 0 || unexpectedFiles.length > 0) {
    return yield* new WindowsPreparedServerCacheError({
      reason: "contents-mismatch",
      cacheDir,
      ...(missingFiles.length > 0 ? { missingFiles } : {}),
      ...(unexpectedFiles.length > 0 ? { unexpectedFiles } : {}),
    });
  }

  for (const file of expectedFiles) {
    const fileStat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(path.join(cacheDir, file)),
      catch: (cause) =>
        new WindowsPreparedServerCacheError({
          reason: "manifest-invalid",
          cacheDir,
          cause,
        }),
    });
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size <= 0) {
      return yield* new WindowsPreparedServerCacheError({
        reason: "manifest-invalid",
        cacheDir,
        cause: new Error(`Prepared server cache file ${file} must be a non-empty regular file`),
      });
    }
  }

  const fileCount = diskFiles.size + 1;
  yield* Effect.log(
    `[desktop-artifact] Validated prepared server cache (${String(manifest.entries.length)} entries, ${String(fileCount)} files).`,
  );
  return {
    present: true,
    entryCount: manifest.entries.length,
    fileCount,
  } as const;
});
