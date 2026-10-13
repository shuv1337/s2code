import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { LOCAL_SERVER_ATTACHMENT_FILE } from "@t3tools/shared/localServerAttachment";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { discover } from "./DesktopLocalServerAttach.ts";
import { runBackendProcess } from "./DesktopBackendManager.ts";

const record = {
  version: 1,
  pid: process.pid,
  port: 3773,
  serverVersion: "1.2.3",
  bootstrapSecret: "a".repeat(64),
};
const descriptor = {
  environmentId: "test",
  label: "test",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.2.3",
  capabilities: { repositoryIdentity: true },
};
const http = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json(
        request.url.endsWith("/oauth/token")
          ? {
              access_token: "test-session",
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "orchestration:read",
            }
          : descriptor,
      ),
    ),
  ),
);
const layer = Layer.mergeAll(NodeServices.layer, Layer.succeed(HttpClient.HttpClient, http));

describe("local desktop attachment", () => {
  it.effect.each([
    "valid",
    "absent",
    "stale",
    "stale-with-live-runtime",
    "version",
    "legacy",
    "unavailable",
    "auth-rejected",
  ] as const)("%s", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      if (scenario === "legacy") {
        yield* fs.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          JSON.stringify({ pid: process.pid }),
        );
      } else if (scenario !== "absent") {
        yield* fs.writeFileString(
          path.join(stateDir, LOCAL_SERVER_ATTACHMENT_FILE),
          JSON.stringify({
            ...record,
            ...(scenario === "stale" || scenario === "stale-with-live-runtime"
              ? { pid: 2147483647 }
              : {}),
            ...(scenario === "version" ? { serverVersion: "older" } : {}),
          }),
        );
      }
      if (scenario === "stale-with-live-runtime") {
        yield* fs.writeFileString(
          path.join(stateDir, "server-runtime.json"),
          JSON.stringify({ pid: process.pid }),
        );
      }
      const result = discover({ stateDir, appVersion: "1.2.3" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          scenario === "unavailable" || scenario === "auth-rejected"
            ? HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    scenario === "unavailable" || request.url.endsWith("/oauth/token")
                      ? new Response("Rejected", {
                          status: scenario === "auth-rejected" ? 401 : 503,
                        })
                      : Response.json(descriptor),
                  ),
                ),
              )
            : http,
        ),
      );
      if (
        scenario === "version" ||
        scenario === "stale-with-live-runtime" ||
        scenario === "legacy" ||
        scenario === "unavailable" ||
        scenario === "auth-rejected"
      ) {
        assert.equal((yield* Effect.flip(result))._tag, "LocalServerAttachmentError");
      } else {
        assert.deepEqual(yield* result, scenario === "valid" ? record : null);
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("detaching never spawns or terminates the independent server", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const fiber = yield* runBackendProcess({
        attachedPid: process.pid,
        executablePath: "must-not-spawn",
        entryPath: "must-not-spawn",
        cwd: "/",
        args: [],
        env: {},
        extendEnv: false,
        captureOutput: false,
        bootstrapDelivery: "fd3",
        preflightFailure: Option.none(),
        httpBaseUrl: new URL("http://127.0.0.1:3773"),
        bootstrap: {
          mode: "desktop",
          port: 3773,
          host: "127.0.0.1",
          desktopBootstrapToken: "test",
          noBrowser: true,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        },
        desktopTelemetryStream: Stream.empty,
        onReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      assert.doesNotThrow(() => process.kill(process.pid, 0));
    }).pipe(
      Effect.scoped,
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("must not spawn")),
      ),
      Effect.provide(layer),
    ),
  );
});
