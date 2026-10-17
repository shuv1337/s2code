// @effect-diagnostics nodeBuiltinImport:off - Exercises runtime ownership on disposable filesystem fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ensureProductHome } from "@t3tools/shared/productHome";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { HttpClient, HttpClientResponse, HttpClientError } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import { ensurePinnedRuntimeInstalled, PinnedRuntimeInstallError } from "./pinnedRuntime.ts";
import * as ProcessRunner from "../processRunner.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-runtime-"));
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const version = "1.2.3";
function install(
  baseDir: string,
  validate = vi.fn(),
  failure?:
    | "offline"
    | "checksums"
    | "download"
    | "checksum"
    | "extract"
    | "validate"
    | "publish"
    | "rollback"
    | "windows-publish",
  platform: NodeJS.Platform = "linux",
) {
  const archive = new TextEncoder().encode("fixture archive");
  const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: string[] = [];
  const vacated = new Set<string>();
  const renameBlocked = Deferred.makeUnsafe<void>();
  const effect = Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return yield* ensurePinnedRuntimeInstalled({
      baseDir,
      version,
      fs:
        failure === "publish" || failure === "rollback" || failure === "windows-publish"
          ? {
              ...filesystem,
              remove: (file, options) =>
                filesystem.remove(file, options).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      vacated.add(file);
                    }),
                  ),
                ),
              rename: (source, destination) =>
                ((failure === "publish" || failure === "rollback") &&
                  (source.includes(".staging-") ||
                    (failure === "rollback" && source.includes(".previous-"))) &&
                  destination.endsWith(version)) ||
                (failure === "windows-publish" && vacated.delete(destination))
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: destination,
                      }),
                    ).pipe(Effect.tapError(() => Deferred.succeed(renameBlocked, undefined)))
                  : filesystem.rename(source, destination).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          vacated.add(source);
                        }),
                      ),
                    ),
            }
          : filesystem,
      path: paths,
      platform,
      arch: "x64",
      releaseBaseUrl: "https://fork.invalid/releases/download",
      httpClient: HttpClient.make((request) => {
        requests.push(request.url);
        if (failure === "offline")
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("Network is offline"),
              }),
            }),
          );
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              request.url.endsWith("SHA256SUMS")
                ? `${failure === "checksum" ? "0".repeat(64) : digest}  shuv2code-${version}-${platform}-x64.${platform === "win32" ? "zip" : "tar.gz"}\n`
                : archive,
              {
                status:
                  (failure === "checksums" && request.url.endsWith("SHA256SUMS")) ||
                  (failure === "download" && !request.url.endsWith("SHA256SUMS"))
                    ? 503
                    : 200,
              },
            ),
          ),
        );
      }),
      runner: ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            const staging = input.args[input.args.indexOf("-C") + 1]!;
            yield* filesystem
              .writeFileString(
                paths.join(staging, platform === "win32" ? "t3.exe" : "t3"),
                "fork-runtime",
              )
              .pipe(Effect.orDie);
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(failure === "extract" ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
      validate: (runtime) =>
        failure === "validate"
          ? Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" }))
          : Effect.sync(() => {
              validate(runtime);
            }),
    });
  });
  return {
    result: effect.pipe(Effect.provide(NodeServices.layer)),
    requests,
    validate,
    renameBlocked,
  };
}
it.effect("records identity and reuses only a complete owned cache", () =>
  Effect.gen(function* () {
    const home = NodePath.join(root, "custom");
    const first = install(home);
    const runtime = yield* first.result;
    expect(NodeFS.readFileSync(runtime.sentinelPath, "utf8").trim()).toBe(version);
    expect(
      NodeFS.readFileSync(NodePath.join(runtime.versionDir, ".install-product"), "utf8").trim(),
    ).toBe("shuv2code");
    expect(first.requests).toHaveLength(2);
    const second = install(home);
    expect(yield* second.result).toEqual(runtime);
    expect(second.requests).toEqual([]);
  }),
);

it.effect(
  "uses a fresh Windows backup destination and retries transient vacated-name publication failures",
  () =>
    Effect.gen(function* () {
      const home = NodePath.join(root, "windows-home");
      ensureProductHome(home);
      const cache = NodePath.join(home, "runtime", "versions", version);
      NodeFS.mkdirSync(cache, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(cache, "t3.exe"), "old-windows-runtime");
      const attempt = install(home, vi.fn(), "windows-publish", "win32");
      const running = yield* attempt.result.pipe(Effect.forkChild);
      yield* Deferred.await(attempt.renameBlocked);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(running);
      expect(NodeFS.readFileSync(NodePath.join(cache, "t3.exe"), "utf8")).toBe("fork-runtime");
      expect(NodeFS.readdirSync(NodePath.dirname(cache))).toEqual([version]);
    }),
);
it.effect.each(["1.2.3\n", "t3code\n1.2.3\n"])(
  "refuses same-version foreign cache %j without deleting or executing it",
  (marker) =>
    Effect.gen(function* () {
      const home = NodePath.join(root, "custom");
      ensureProductHome(home);
      const cache = NodePath.join(home, "runtime", "versions", version);
      NodeFS.mkdirSync(cache, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(cache, ".install-complete"), marker);
      NodeFS.writeFileSync(NodePath.join(cache, ".install-product"), "t3code\n");
      NodeFS.writeFileSync(NodePath.join(cache, "t3"), "upstream-sentinel");
      const attempt = install(home);
      const failure = yield* attempt.result.pipe(Effect.flip);
      expect(failure.message).toContain("foreign runtime cache");
      expect(attempt.validate).not.toHaveBeenCalled();
      expect(attempt.requests).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(cache, "t3"), "utf8")).toBe("upstream-sentinel");
    }),
);
it.effect("refetches unmarked metadata even under a fork-named directory", () =>
  Effect.gen(function* () {
    const home = NodePath.join(root, ".shuv2code-v2");
    ensureProductHome(home);
    const cache = NodePath.join(home, "runtime", "versions", version);
    NodeFS.mkdirSync(cache, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cache, ".install-complete"), `${version}\n`);
    NodeFS.writeFileSync(NodePath.join(cache, "t3"), "legacy-fork-runtime");
    const attempt = install(
      home,
      vi.fn(() => {
        // Publication must not remove the old tree while staging is validated.
        expect(NodeFS.readFileSync(NodePath.join(cache, "t3"), "utf8")).toBe("legacy-fork-runtime");
      }),
    );
    yield* attempt.result;
    expect(attempt.requests).toHaveLength(2);
    expect(attempt.validate).toHaveBeenCalledTimes(1);
    expect(NodeFS.readFileSync(NodePath.join(cache, "t3"), "utf8")).toBe("fork-runtime");
    expect(NodeFS.readdirSync(NodePath.dirname(cache))).toEqual([version]);
  }),
);

it.effect.each([
  "offline",
  "checksums",
  "download",
  "checksum",
  "extract",
  "validate",
  "publish",
] as const)("preserves an unmarked cache and installed link when refetch fails at %s", (failure) =>
  Effect.gen(function* () {
    const home = NodePath.join(root, "custom");
    ensureProductHome(home);
    const cache = NodePath.join(home, "runtime", "versions", version);
    NodeFS.mkdirSync(cache, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cache, ".install-complete"), `${version}\n`);
    const executable = NodePath.join(cache, "t3");
    NodeFS.writeFileSync(executable, "previous-executable");
    const link = NodePath.join(home, "installed-cli");
    if (symlinksSupported) NodeFS.symlinkSync(executable, link);
    const attempt = install(home, vi.fn(), failure);
    yield* attempt.result.pipe(Effect.flip);
    expect(NodeFS.readFileSync(executable, "utf8")).toBe("previous-executable");
    if (symlinksSupported) expect(NodeFS.readFileSync(link, "utf8")).toBe("previous-executable");
    expect(NodeFS.readFileSync(NodePath.join(cache, ".install-complete"), "utf8")).toBe(
      `${version}\n`,
    );
    expect(NodeFS.existsSync(NodePath.join(cache, ".install-product"))).toBe(false);
    expect(NodeFS.readdirSync(NodePath.dirname(cache))).toEqual([version]);
  }),
);

it.effect("keeps the previous executable in its reported backup if rollback also fails", () =>
  Effect.gen(function* () {
    const home = NodePath.join(root, "custom");
    ensureProductHome(home);
    const cache = NodePath.join(home, "runtime", "versions", version);
    NodeFS.mkdirSync(cache, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cache, "t3"), "previous-executable");
    const error = yield* install(home, vi.fn(), "rollback").result.pipe(Effect.flip);
    const backups = NodeFS.readdirSync(NodePath.dirname(cache));
    expect(backups).toHaveLength(2);
    const backup = NodePath.join(
      NodePath.dirname(cache),
      backups.find((name) => name.startsWith(".previous-"))!,
      "runtime",
    );
    const staging = NodePath.join(
      NodePath.dirname(cache),
      backups.find((name) => name.startsWith(".staging-"))!,
    );
    expect(error.message).toContain(backup);
    expect(NodeFS.readFileSync(NodePath.join(backup, "t3"), "utf8")).toBe("previous-executable");
    expect(error.message).toContain(staging);
    expect(NodeFS.readFileSync(NodePath.join(staging, "t3"), "utf8")).toBe("fork-runtime");
  }),
);

it.effect("does not delete a cache whose completion metadata cannot be read", () =>
  Effect.gen(function* () {
    const home = NodePath.join(root, "custom");
    ensureProductHome(home);
    const cache = NodePath.join(home, "runtime", "versions", version);
    NodeFS.mkdirSync(NodePath.join(cache, ".install-complete"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cache, "t3"), "preserved-runtime");
    const attempt = install(home);
    yield* attempt.result.pipe(Effect.flip);
    expect(attempt.validate).not.toHaveBeenCalled();
    expect(attempt.requests).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(cache, "t3"), "utf8")).toBe("preserved-runtime");
  }),
);
