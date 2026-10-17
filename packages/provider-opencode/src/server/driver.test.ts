// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderMaintenance from "@t3tools/provider-core/server/maintenanceResolver";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  OPENCODE_2_RESPONSES,
  OPENCODE_2_WORKSPACE_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";
import {
  enrichOpenCodeSnapshotWithVersionAdvisory,
  OpenCodeDriver,
  openCodeUpdateFor,
} from "./driver.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const serverStarts: Array<string> = [];
const reachedServer = (operation: string) =>
  Effect.sync(() => serverStarts.push(operation)).pipe(
    Effect.andThen(
      Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation,
          detail: "reached a 1.x server path",
        }),
      ),
    ),
  );
// Reports OpenCode 2 from `--version`; any attempt to reach a server is recorded and refused.
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

it.layer(layer)("OpenCodeDriver runtime selection", (it) => {
  it.effect("never starts a 1.x server for an OpenCode 2 instance", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const instance = yield* create({}, noHttp);
      // Text generation goes to the instance's 2.x server, which this test refuses to start.
      yield* Effect.flip(
        instance.textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "hello",
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
        }),
      );
      assert.deepStrictEqual(serverStarts, ["start"]);
    }).pipe(Effect.scoped),
  );

  it.effect("lists an OpenCode 2 workspace's own skills and commands from its server", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const requested: Array<string> = [];
      const server = replayOpenCodeServer(
        { ...OPENCODE_2_RESPONSES, ...OPENCODE_2_WORKSPACE_RESPONSES },
        "secret",
        requested,
      );
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
        server,
      );

      const workspace = yield* instance.snapshotForCwd!("/work");
      assert.includeMembers(
        workspace.skills.map((skill) => skill.name),
        ["plum", "opencode"],
      );
      assert.deepStrictEqual(
        workspace.slashCommands.map((command) => command.name),
        ["compact", "init", "review", "bee"],
      );
      assert.include(requested, "/api/skill");
      assert.deepStrictEqual(serverStarts, []);
    }).pipe(Effect.scoped),
  );

  it.effect("answers capability reads without waiting on an unreachable server", () =>
    Effect.gen(function* () {
      const hang = HttpClient.make(() => Effect.never);
      const instance = yield* create({ serverUrl: "http://127.0.0.1:9" }, hang);

      // No probe has succeeded yet, and the server never answers: the 1.x default applies.
      const capabilities = yield* instance.orchestrationAdapter
        .getCapabilities()
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isDefined(capabilities.pollUnsafe());
      yield* Fiber.join(capabilities);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

// npm links `<prefix>/bin/opencode` into the package that installed it:
// `opencode-ai` for 1.x and `@opencode/cli` (whose bin is `bin/opencode.exe`) for 2.x.
const npmGlobalInstall = (
  prefix: string,
  packagePath: ReadonlyArray<string>,
  bin: string,
  command = "opencode",
) => {
  const target = NodePath.join(prefix, "lib", "node_modules", ...packagePath, "bin", bin);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, "#!/bin/sh\n");
  NodeFS.chmodSync(target, 0o755);
  const link = NodePath.join(prefix, "bin", command);
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
};
const resolveUpdate = (generation: "v1" | "v2", binaryPath: string) =>
  ProviderMaintenance.resolveProviderMaintenanceCapabilitiesEffect(openCodeUpdateFor(generation), {
    binaryPath,
    env: { PATH: "" },
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("resolving an update must not spawn")),
    ),
    Effect.provide(NodeServices.layer),
  );

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "updates an npm-global OpenCode 2 install as @opencode/cli and a 1.x one as opencode-ai",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-update-")),
      );
      const v2Prefix = NodePath.join(root, "v2");
      const v1Prefix = NodePath.join(root, "v1");
      const v2 = yield* resolveUpdate(
        "v2",
        npmGlobalInstall(v2Prefix, ["@opencode", "cli"], "opencode.exe"),
      );
      assert.deepStrictEqual(v2.update?.args, [
        "install",
        "-g",
        "--prefix",
        v2Prefix,
        "--allow-scripts=@opencode/cli",
        "@opencode/cli@latest",
      ]);
      const v1 = yield* resolveUpdate(
        "v1",
        npmGlobalInstall(v1Prefix, ["opencode-ai"], "opencode"),
      );
      assert.strictEqual(v1.update?.args.at(-1), "opencode-ai@latest");
      // A 1.x install is never offered 2.x's package, or the reverse.
      assert.isNull(
        (yield* resolveUpdate("v2", NodePath.join(v1Prefix, "bin", "opencode"))).update,
      );
      assert.isNull(
        (yield* resolveUpdate("v1", NodePath.join(v2Prefix, "bin", "opencode"))).update,
      );
    }),
);

it.effect("recognizes owned and unowned Windows shuvcode shims without targeting OpenCode", () =>
  Effect.gen(function* () {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-windows-shuvcode-update-")),
    );
    const ownedShim = NodePath.join(root, "shuvcode.cmd");
    NodeFS.writeFileSync(ownedShim, "@echo off\r\n");
    const manifest = NodePath.join(root, "node_modules", "shuvcode-node", "package.json");
    NodeFS.mkdirSync(NodePath.dirname(manifest), { recursive: true });
    NodeFS.writeFileSync(manifest, '{"name":"shuvcode-node"}');

    const resolver = openCodeUpdateFor("v2");
    const owned = yield* resolver.resolve({
      binaryPath: "shuvcode.cmd",
      resolvedCommandPath: ownedShim,
      realCommandPath: ownedShim,
      env: {},
      platform: "win32",
    });
    assert.strictEqual(owned.packageName, "shuvcode-node");
    assert.deepStrictEqual(owned.update?.args, ["upgrade"]);
    assert.strictEqual(owned.update?.executable, ownedShim);

    for (const extension of ["cmd", "bat", "exe", "ps1"] as const) {
      const unownedPath = NodePath.join(root, ".bun", "bin", `shuvcode.${extension}`);
      const unowned = yield* resolver.resolve({
        binaryPath: `shuvcode.${extension}`,
        resolvedCommandPath: unownedPath,
        realCommandPath: unownedPath,
        env: {},
        platform: "win32",
      });
      assert.strictEqual(unowned.packageName, "shuvcode");
      assert.isNull(unowned.update);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "uses shuvcode's native updater for npm and bun package installs",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-shuvcode-update-")),
      );
      const npmBinary = npmGlobalInstall(
        NodePath.join(root, "npm"),
        ["shuvcode"],
        "launcher.mjs",
        "shuvcode",
      );
      const npm = yield* resolveUpdate("v2", npmBinary);
      assert.strictEqual(npm.packageName, "shuvcode");
      assert.deepStrictEqual(npm.update, {
        command: `${npmBinary} upgrade`,
        executable: npmBinary,
        args: ["upgrade"],
        lockKey: "opencode-native",
      });

      const bunRoot = NodePath.join(root, ".bun");
      const bunTarget = NodePath.join(
        bunRoot,
        "install",
        "global",
        "node_modules",
        "shuvcode-node-darwin-arm64",
        "bin",
        "shuvcode",
      );
      NodeFS.mkdirSync(NodePath.dirname(bunTarget), { recursive: true });
      NodeFS.writeFileSync(bunTarget, "#!/bin/sh\n");
      NodeFS.chmodSync(bunTarget, 0o755);
      const bunBinary = NodePath.join(bunRoot, "bin", "shuvcode");
      NodeFS.mkdirSync(NodePath.dirname(bunBinary), { recursive: true });
      NodeFS.symlinkSync(bunTarget, bunBinary);
      const bun = yield* resolveUpdate("v2", bunBinary);
      assert.strictEqual(bun.packageName, "shuvcode-node");
      assert.deepStrictEqual(bun.update?.args, ["upgrade"]);
      assert.strictEqual(bun.update?.executable, bunBinary);
    }),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "keeps an unowned shuvcode binary manual and never targets upstream OpenCode",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-standalone-shuvcode-")),
      );
      const binary = NodePath.join(root, "shuvcode");
      NodeFS.writeFileSync(binary, "#!/bin/sh\n");
      NodeFS.chmodSync(binary, 0o755);

      const capabilities = yield* resolveUpdate("v2", binary);
      assert.strictEqual(capabilities.packageName, "shuvcode");
      assert.isNull(capabilities.update);
    }),
);

const externalServerProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("shuvcode-server"),
  driver: ProviderDriverKind.make("opencode"),
  enabled: true,
  installed: true,
  version: "2.0.28-shuv.1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-17T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const shuvcodeMaintenance = ProviderMaintenance.makeProviderMaintenanceCapabilities({
  provider: ProviderDriverKind.make("opencode"),
  packageName: "shuvcode",
  updateExecutable: "/opt/shuvcode/bin/shuvcode",
  updateArgs: ["upgrade"],
  updateLockKey: "opencode-native",
});

it.effect("compares an external server against the installed shuvcode version", () =>
  Effect.gen(function* () {
    const current = yield* enrichOpenCodeSnapshotWithVersionAdvisory({
      snapshot: externalServerProvider,
      maintenanceCapabilities: shuvcodeMaintenance,
      installedRuntime: { generation: "v2", version: "2.0.30-shuv.1" },
      usesExternalServer: true,
      enableProviderUpdateChecks: true,
    });
    assert.strictEqual(current.version, "2.0.28-shuv.1");
    assert.strictEqual(current.versionAdvisory?.currentVersion, "2.0.30-shuv.1");
    assert.strictEqual(current.versionAdvisory?.status, "current");
    assert.include(
      current.versionAdvisory?.message ?? "",
      "will use the new version after it restarts",
    );

    const behind = yield* enrichOpenCodeSnapshotWithVersionAdvisory({
      snapshot: externalServerProvider,
      maintenanceCapabilities: shuvcodeMaintenance,
      installedRuntime: { generation: "v2", version: "2.0.29-shuv.1" },
      usesExternalServer: true,
      enableProviderUpdateChecks: true,
    });
    assert.strictEqual(behind.versionAdvisory?.status, "behind_latest");
    assert.strictEqual(behind.versionAdvisory?.updateCommand, "/opt/shuvcode/bin/shuvcode upgrade");
  }).pipe(
    Effect.provideServiceEffect(
      ProviderLatestVersions.ProviderLatestVersions,
      ProviderLatestVersions.make([["shuvcode", "2.0.30-shuv.1"]]),
    ),
    Effect.provideService(HttpClient.HttpClient, noHttp),
  ),
);

// The update the driver offers follows the version the binary reports now.
const versionOutput: { current: string | undefined } = { current: undefined };
const versionProbes: Array<string> = [];
const changingRuntime = {
  runOpenCodeCommand: ({ binaryPath }: { readonly binaryPath: string }) =>
    Effect.sync(() => versionProbes.push(binaryPath)).pipe(
      Effect.andThen(
        versionOutput.current === undefined
          ? Effect.fail(
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "version",
                detail: "no version",
              }),
            )
          : Effect.succeed({ stdout: versionOutput.current, stderr: "", code: 0 }),
      ),
    ),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
const layerUpdate = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, changingRuntime),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layerUpdate)("OpenCodeDriver updates", (it) => {
  it.effect("never runs the binary for a disabled instance's update check", () =>
    Effect.gen(function* () {
      versionProbes.length = 0;
      versionOutput.current = "opencode v2.0.18\n";
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-disabled"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: { ...OpenCodeDriver.defaultConfig(), binaryPath: "opencode" },
      }).pipe(Effect.provideService(HttpClient.HttpClient, noHttp));
      const maintenance = yield* instance.snapshot.resolveMaintenance();
      yield* instance.snapshot.resolveMaintenance({ fresh: true });
      assert.isNull(maintenance.update);
      assert.deepStrictEqual(versionProbes, []);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "offers no package update for an unknown version and follows a changed one on a fresh read",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-driver-update-")),
        );
        const binaryPath = npmGlobalInstall(NodePath.join(root, "v1"), ["opencode-ai"], "opencode");
        const instance = yield* OpenCodeDriver.create({
          instanceId: ProviderInstanceId.make("opencode-update"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: { ...OpenCodeDriver.defaultConfig(), binaryPath },
        }).pipe(Effect.provideService(HttpClient.HttpClient, noHttp));

        // The version could not be read: which package owns the binary is unknown.
        versionOutput.current = undefined;
        const unknown = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isNull(unknown.update);
        assert.isNull(unknown.packageName);

        versionOutput.current = "1.18.32\n";
        const v1 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v1.packageName, "opencode-ai");

        // The same path now reports 2.x (reinstalled in place): a fresh read re-probes
        // and never offers 1.x's package for it.
        versionOutput.current = "opencode v2.0.18\n";
        const v2 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v2.packageName, "@opencode/cli");
        assert.isNull(v2.update);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refreshes installed and server versions for external-server advisories",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-external-shuvcode-refresh-")),
        );
        const binaryPath = NodePath.join(root, "shuvcode");
        NodeFS.writeFileSync(binaryPath, "#!/bin/sh\n");
        NodeFS.chmodSync(binaryPath, 0o755);
        let serverVersion = "2.0.28-shuv.1";
        const replay = replayOpenCodeServer(OPENCODE_2_RESPONSES, "");
        const http = HttpClient.make((request, url) => {
          if (url.hostname === "registry.npmjs.org") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ version: "2.0.30-shuv.1" })),
            );
          }
          if (url.pathname === "/api/info") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ version: serverVersion, pid: 1234 }),
              ),
            );
          }
          return replay.execute(request);
        });
        versionOutput.current = "shuvcode v2.0.28-shuv.1\n";
        const instance = yield* create({ binaryPath, serverUrl: "http://127.0.0.1:4096" }, http);
        const refreshAndReadEnriched = Effect.gen(function* () {
          const enriched = yield* instance.snapshot.streamChanges.pipe(
            Stream.filter((snapshot) => snapshot.versionAdvisory !== undefined),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* instance.snapshot.refresh;
          return Array.from(yield* Fiber.join(enriched))[0]!;
        });

        const outdated = yield* refreshAndReadEnriched;
        assert.strictEqual(outdated.versionAdvisory?.status, "behind_latest");

        versionOutput.current = "shuvcode v2.0.30-shuv.1\n";
        const restartPending = yield* refreshAndReadEnriched;
        const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(maintenance.installedVersion, "2.0.30-shuv.1");
        assert.strictEqual(restartPending.version, "2.0.28-shuv.1");
        assert.strictEqual(restartPending.versionAdvisory?.status, "current");
        assert.include(restartPending.versionAdvisory?.message ?? "", "after it restarts");

        serverVersion = "2.0.30-shuv.1";
        const restarted = yield* refreshAndReadEnriched;
        assert.strictEqual(restarted.version, "2.0.30-shuv.1");
        assert.isNull(restarted.versionAdvisory?.message);
      }).pipe(Effect.scoped),
  );
});
