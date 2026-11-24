// @effect-diagnostics nodeBuiltinImport:off -- Tests create real temp directories and symlinks to verify fail-closed filesystem checks.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { createPackageWithOptions } from "@electron/asar";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { seedPreparedCache } from "./lib/server-compile-cache.ts";
import {
  WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT,
  WindowsPreparedServerCacheError,
  validateWindowsPreparedServerCache,
} from "./windows-prepared-server-cache.ts";

const TEST_RUNTIME = "36.0.0-v24.0.0-win32-x64-1234567890";

const hexFileName = (index: number) => (0x10000000 + index).toString(16).padStart(8, "0");

const makePreparedCacheFixture = Effect.fn("test.makePreparedCacheFixture")(function* (input: {
  readonly moduleCount: number;
  readonly createCache?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-win-prepared-cache-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const distDir = path.join(sourceDir, "apps/server/dist");
  yield* fs.makeDirectory(distDir, { recursive: true });

  const entries: Array<{ module: string; file: string }> = [];
  for (let index = 0; index < input.moduleCount; index++) {
    const moduleName =
      index === 0
        ? "binCli-fixture.mjs"
        : index === 1
          ? "server-fixture.mjs"
          : `chunk-${String(index).padStart(3, "0")}.mjs`;
    yield* fs.writeFileString(
      path.join(distDir, moduleName),
      `export const chunkIndex = ${String(index)};\n`,
    );
    entries.push({
      module: `server.asar/apps/server/dist/${moduleName}`,
      file: hexFileName(index),
    });
  }

  const resourcesDir = path.join(tempDir, "resources");
  yield* fs.makeDirectory(resourcesDir, { recursive: true });
  const asarPath = path.join(resourcesDir, "server.asar");
  yield* Effect.promise(() => createPackageWithOptions(sourceDir, asarPath, {}));

  const cacheDir = path.join(resourcesDir, "server-compile-cache");
  if (input.createCache !== false) {
    yield* fs.makeDirectory(cacheDir, { recursive: true });
    for (const entry of entries) {
      yield* fs.writeFileString(path.join(cacheDir, entry.file), `bytecode:${entry.module}`);
    }
    yield* fs.writeFileString(
      path.join(cacheDir, "manifest.json"),
      JSON.stringify({
        format: 1,
        runtime: TEST_RUNTIME,
        entries,
      }),
    );
  }

  return {
    tempDir,
    resourcesDir,
    asarPath,
    cacheDir,
    entries,
  } as const;
});

it.layer(NodeServices.layer)("windows-prepared-server-cache", (it) => {
  it.effect("returns absent with zero counts when server-compile-cache does not exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makePreparedCacheFixture({
          moduleCount: 2,
          createCache: false,
        });
        const result = yield* validateWindowsPreparedServerCache({
          resourcesDir: fixture.resourcesDir,
          asarPath: fixture.asarPath,
        });

        assert.deepStrictEqual(result, {
          present: false,
          entryCount: 0,
          fileCount: 0,
        });
      }),
    ),
  );

  it.effect(
    "validates a 37-entry cache backed by server.asar and keeps parity with seedPreparedCache",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixture = yield* makePreparedCacheFixture({ moduleCount: 37 });
          const result = yield* validateWindowsPreparedServerCache({
            resourcesDir: fixture.resourcesDir,
            asarPath: fixture.asarPath,
          });

          assert.deepStrictEqual(result, {
            present: true,
            entryCount: 37,
            fileCount: 38,
          });

          const activeCacheDir = path.join(fixture.tempDir, "active-cache");
          yield* fs.makeDirectory(activeCacheDir, { recursive: true });
          assert.equal(seedPreparedCache(fixture.cacheDir, activeCacheDir, TEST_RUNTIME), true);
        }),
      ),
  );

  it.effect("rejects missing manifest.json and invalid manifest schemas or values", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makePreparedCacheFixture({ moduleCount: 2 });
        const manifestPath = path.join(fixture.cacheDir, "manifest.json");

        yield* fs.remove(manifestPath);
        const missingManifestError = yield* validateWindowsPreparedServerCache({
          resourcesDir: fixture.resourcesDir,
          asarPath: fixture.asarPath,
        }).pipe(Effect.flip);
        assert.instanceOf(missingManifestError, WindowsPreparedServerCacheError);
        assert.equal(missingManifestError.reason, "manifest-invalid");
        assert.deepStrictEqual(missingManifestError.missingFiles, ["manifest.json"]);

        const invalidManifests: ReadonlyArray<string> = [
          "{not valid json",
          JSON.stringify({ format: 2, runtime: TEST_RUNTIME, entries: fixture.entries }),
          JSON.stringify({ format: 1, runtime: "", entries: fixture.entries }),
          JSON.stringify({ format: 1, runtime: "   ", entries: fixture.entries }),
          JSON.stringify({ format: 1, runtime: TEST_RUNTIME, entries: [] }),
          JSON.stringify({
            format: 1,
            runtime: TEST_RUNTIME,
            entries: [{ module: fixture.entries[0]!.module, file: "BADFILE!" }],
          }),
          JSON.stringify({
            format: 1,
            runtime: TEST_RUNTIME,
            entries: [
              { module: "app.asar/apps/server/dist/binCli-fixture.mjs", file: hexFileName(0) },
            ],
          }),
          JSON.stringify({
            format: 1,
            runtime: TEST_RUNTIME,
            entries: [
              { module: "server.asar/apps/server/dist/../escape.mjs", file: hexFileName(0) },
            ],
          }),
          JSON.stringify({
            format: 1,
            runtime: TEST_RUNTIME,
            entries: [
              fixture.entries[0]!,
              { module: fixture.entries[1]!.module, file: fixture.entries[0]!.file },
            ],
          }),
          JSON.stringify({
            format: 1,
            runtime: TEST_RUNTIME,
            entries: [
              fixture.entries[0]!,
              { module: fixture.entries[0]!.module, file: fixture.entries[1]!.file },
            ],
          }),
          JSON.stringify({
            format: 1,
            runtime: TEST_RUNTIME,
            entries: [
              fixture.entries[0]!,
              {
                module: "server.asar/apps/server/dist/missing-from-asar.mjs",
                file: hexFileName(1),
              },
            ],
          }),
        ];

        for (const payload of invalidManifests) {
          yield* fs.writeFileString(manifestPath, payload);
          const error = yield* validateWindowsPreparedServerCache({
            resourcesDir: fixture.resourcesDir,
            asarPath: fixture.asarPath,
          }).pipe(Effect.flip);
          assert.instanceOf(error, WindowsPreparedServerCacheError);
          assert.equal(error.reason, "manifest-invalid");
        }
      }),
    ),
  );

  it.effect("rejects 0-byte cache files and non-directory or symlinked cache roots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makePreparedCacheFixture({ moduleCount: 2 });

        yield* fs.writeFileString(path.join(fixture.cacheDir, fixture.entries[0]!.file), "");
        const emptyFileError = yield* validateWindowsPreparedServerCache({
          resourcesDir: fixture.resourcesDir,
          asarPath: fixture.asarPath,
        }).pipe(Effect.flip);
        assert.instanceOf(emptyFileError, WindowsPreparedServerCacheError);
        assert.equal(emptyFileError.reason, "manifest-invalid");

        yield* fs.remove(fixture.cacheDir, { recursive: true });
        yield* fs.writeFileString(fixture.cacheDir, "not a directory");
        const regularFileRootError = yield* validateWindowsPreparedServerCache({
          resourcesDir: fixture.resourcesDir,
          asarPath: fixture.asarPath,
        }).pipe(Effect.flip);
        assert.instanceOf(regularFileRootError, WindowsPreparedServerCacheError);
        assert.equal(regularFileRootError.reason, "manifest-invalid");

        if (symlinksSupported) {
          const targetDir = path.join(fixture.tempDir, "symlink-target");
          yield* fs.makeDirectory(targetDir, { recursive: true });
          yield* fs.remove(fixture.cacheDir);
          yield* Effect.promise(() => NodeFSP.symlink(targetDir, fixture.cacheDir));
          const symlinkRootError = yield* validateWindowsPreparedServerCache({
            resourcesDir: fixture.resourcesDir,
            asarPath: fixture.asarPath,
          }).pipe(Effect.flip);
          assert.instanceOf(symlinkRootError, WindowsPreparedServerCacheError);
          assert.equal(symlinkRootError.reason, "manifest-invalid");
        }
      }),
    ),
  );

  it.effect(
    "rejects extra files, nested directories, symlinks inside cacheDir, and missing entries",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fixture = yield* makePreparedCacheFixture({ moduleCount: 2 });

          const extraFile = path.join(fixture.cacheDir, "deadbeef");
          yield* fs.writeFileString(extraFile, "stray bytecode");
          const extraFileError = yield* validateWindowsPreparedServerCache({
            resourcesDir: fixture.resourcesDir,
            asarPath: fixture.asarPath,
          }).pipe(Effect.flip);
          assert.instanceOf(extraFileError, WindowsPreparedServerCacheError);
          assert.equal(extraFileError.reason, "contents-mismatch");
          assert.deepStrictEqual(extraFileError.unexpectedFiles, ["deadbeef"]);
          yield* fs.remove(extraFile);

          const nestedDir = path.join(fixture.cacheDir, "node_modules/pkg");
          yield* fs.makeDirectory(nestedDir, { recursive: true });
          yield* fs.writeFileString(path.join(nestedDir, "index.js"), "module.exports = {};");
          const nestedDirError = yield* validateWindowsPreparedServerCache({
            resourcesDir: fixture.resourcesDir,
            asarPath: fixture.asarPath,
          }).pipe(Effect.flip);
          assert.instanceOf(nestedDirError, WindowsPreparedServerCacheError);
          assert.equal(nestedDirError.reason, "contents-mismatch");
          assert.deepStrictEqual(nestedDirError.unexpectedFiles, ["node_modules"]);
          yield* fs.remove(path.join(fixture.cacheDir, "node_modules"), { recursive: true });

          if (symlinksSupported) {
            const symlinkPath = path.join(fixture.cacheDir, "cafebabe");
            yield* Effect.promise(() =>
              NodeFSP.symlink(path.join(fixture.cacheDir, fixture.entries[0]!.file), symlinkPath),
            );
            const symlinkError = yield* validateWindowsPreparedServerCache({
              resourcesDir: fixture.resourcesDir,
              asarPath: fixture.asarPath,
            }).pipe(Effect.flip);
            assert.instanceOf(symlinkError, WindowsPreparedServerCacheError);
            assert.equal(symlinkError.reason, "contents-mismatch");
            assert.deepStrictEqual(symlinkError.unexpectedFiles, ["cafebabe"]);
            yield* fs.remove(symlinkPath);
          }

          yield* fs.remove(path.join(fixture.cacheDir, fixture.entries[1]!.file));
          const missingEntryError = yield* validateWindowsPreparedServerCache({
            resourcesDir: fixture.resourcesDir,
            asarPath: fixture.asarPath,
          }).pipe(Effect.flip);
          assert.instanceOf(missingEntryError, WindowsPreparedServerCacheError);
          assert.equal(missingEntryError.reason, "contents-mismatch");
          assert.deepStrictEqual(missingEntryError.missingFiles, [fixture.entries[1]!.file]);
        }),
      ),
  );

  it.effect("enforces WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT = 256 and custom entryLimit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        assert.equal(WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT, 256);

        const smallFixture = yield* makePreparedCacheFixture({ moduleCount: 3 });
        const customLimitError = yield* validateWindowsPreparedServerCache({
          resourcesDir: smallFixture.resourcesDir,
          asarPath: smallFixture.asarPath,
          entryLimit: 2,
        }).pipe(Effect.flip);
        assert.instanceOf(customLimitError, WindowsPreparedServerCacheError);
        assert.equal(customLimitError.reason, "entry-limit-exceeded");
        assert.equal(customLimitError.entryCount, 3);
        assert.equal(customLimitError.entryLimit, 2);

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const oversizedEntries = Array.from(
          { length: WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT + 1 },
          (_, index) => ({
            module: `server.asar/apps/server/dist/chunk-${String(index).padStart(3, "0")}.mjs`,
            file: hexFileName(index),
          }),
        );
        yield* fs.writeFileString(
          path.join(smallFixture.cacheDir, "manifest.json"),
          JSON.stringify({
            format: 1,
            runtime: TEST_RUNTIME,
            entries: oversizedEntries,
          }),
        );
        const defaultLimitError = yield* validateWindowsPreparedServerCache({
          resourcesDir: smallFixture.resourcesDir,
          asarPath: smallFixture.asarPath,
        }).pipe(Effect.flip);
        assert.instanceOf(defaultLimitError, WindowsPreparedServerCacheError);
        assert.equal(defaultLimitError.reason, "entry-limit-exceeded");
        assert.equal(defaultLimitError.entryCount, WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT + 1);
        assert.equal(defaultLimitError.entryLimit, WINDOWS_PREPARED_SERVER_CACHE_ENTRY_LIMIT);
      }),
    ),
  );
});
