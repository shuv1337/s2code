import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDesktopSshCliRunner } from "./DesktopSshEnvironment.ts";

const packagedEnvironment = DesktopEnvironment.DesktopEnvironment.pipe(
  Effect.provide(
    DesktopEnvironment.layer({
      dirname: "/Applications/T3 Code.app/Contents/Resources/app.asar/dist-electron",
      homeDirectory: "/Users/alice",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.22",
      appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
      ),
    ),
  ),
);

describe("resolveDesktopSshCliRunner", () => {
  it.effect("keeps the development build's version with the remote entry point", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      assert.deepStrictEqual(
        resolveDesktopSshCliRunner(
          {
            ...environment,
            isDevelopment: true,
            appVersion: "0.0.22-nightly.1",
            devRemoteT3ServerEntryPath: Option.some("/test/dev/server.mjs"),
          },
          {},
        ),
        {
          nodeScriptPath: "/test/dev/server.mjs",
          version: "0.0.22-nightly.1",
          nodeEngineRange: serverPackageJson.engines.node,
        },
      );
    }),
  );

  it.effect.each([
    { [CLI_RELEASE_BASE_URL_ENV]: " https://mirror.example.com/s2code " },
    { SHUV2CODE_RELEASE_BASE_URL: "https://mirror.example.com/s2code" },
    {
      [CLI_RELEASE_BASE_URL_ENV]: "https://mirror.example.com/s2code",
      SHUV2CODE_RELEASE_BASE_URL: "https://legacy.example.com/s2code",
    },
  ])("downloads the remote runner from the release mirror (%j)", (env) =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;
      assert.deepStrictEqual(resolveDesktopSshCliRunner(environment, env), {
        archiveVersion: "0.0.22",
        releaseBaseUrl: "https://mirror.example.com/s2code",
      });
    }),
  );
});
