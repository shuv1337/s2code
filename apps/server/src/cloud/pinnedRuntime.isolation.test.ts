// @effect-diagnostics nodeBuiltinImport:off - Exercises runtime ownership on disposable filesystem fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ensureProductHome } from "@t3tools/shared/productHome";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import { ensurePinnedRuntimeInstalled } from "./pinnedRuntime.ts";
import * as ProcessRunner from "../processRunner.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-runtime-"));
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const version = "1.2.3";
function install(baseDir: string, validate = vi.fn()) {
  const archive = new TextEncoder().encode("fixture archive");
  const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: string[] = [];
  const effect = Effect.gen(function* () {
    const filesystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return yield* ensurePinnedRuntimeInstalled({
      baseDir,
      version,
      fs: filesystem,
      path: paths,
      platform: "linux",
      arch: "x64",
      releaseBaseUrl: "https://fork.invalid/releases/download",
      httpClient: HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              request.url.endsWith("SHA256SUMS")
                ? `${digest}  t3-${version}-linux-x64.tar.gz\n`
                : archive,
            ),
          ),
        );
      }),
      runner: ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.gen(function* () {
            const staging = input.args[input.args.indexOf("-C") + 1]!;
            yield* filesystem
              .writeFileString(paths.join(staging, "t3"), "fork-runtime")
              .pipe(Effect.orDie);
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
      validate: (runtime) =>
        Effect.sync(() => {
          validate(runtime);
        }),
    });
  });
  return {
    result: effect.pipe(Effect.provide(NodeServices.layer)),
    requests,
    validate,
  };
}
it.effect("records identity and reuses only a complete owned cache", () =>
  Effect.gen(function* () {
    const home = NodePath.join(root, "custom");
    const first = install(home);
    const runtime = yield* first.result;
    expect(NodeFS.readFileSync(runtime.sentinelPath, "utf8")).toBe("shuv2code\n1.2.3\n");
    expect(first.requests).toHaveLength(2);
    const second = install(home);
    expect(yield* second.result).toEqual(runtime);
    expect(second.requests).toEqual([]);
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
      NodeFS.writeFileSync(NodePath.join(cache, "t3"), "upstream-sentinel");
      const attempt = install(home);
      const failure = yield* attempt.result.pipe(Effect.flip);
      expect(failure.message).toContain("foreign runtime cache");
      expect(attempt.validate).not.toHaveBeenCalled();
      expect(attempt.requests).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(cache, "t3"), "utf8")).toBe("upstream-sentinel");
    }),
);
it.effect("keeps version-only metadata in an existing default fork home", () =>
  Effect.gen(function* () {
    const home = NodePath.join(root, ".shuv2code-v2");
    const cache = NodePath.join(home, "runtime", "versions", version);
    NodeFS.mkdirSync(cache, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cache, ".install-complete"), `${version}\n`);
    NodeFS.writeFileSync(NodePath.join(cache, "t3"), "legacy-fork-runtime");
    const attempt = install(home);
    yield* attempt.result;
    expect(attempt.requests).toEqual([]);
    expect(attempt.validate).toHaveBeenCalledTimes(1);
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
