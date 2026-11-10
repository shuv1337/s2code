import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { formatServiceStatus, serviceCommand } from "./service.ts";
import { runUninstall } from "./uninstall.ts";

afterEach(() => vi.restoreAllMocks());

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "T3 Code service",
      "  Status: installed · s2code@0.0.29",
      "  Unit: /home/me/.config/systemd/user/t3code.service",
      "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `s2code service install` to repair it.",
  );
});

it("explains an incomplete nightly installation and keeps repair on its installed version", () => {
  const output = formatServiceStatus(
    {
      ...status,
      current: false,
      installedVersion: "0.0.32-nightly.1",
      problems: ["linger-disabled", "service-stopped"],
    },
    "0.0.32-nightly.1",
  );

  expect(output).toContain("[linger-disabled]");
  expect(output).toContain("last login session ends");
  expect(output).toContain('sudo loginctl enable-linger "$(id -un)"');
  expect(output).toContain("[service-stopped]");
  expect(output).toContain("Run `s2code-nightly service install` to repair it.");
  expect(output).not.toContain("npx");
});

it("points an older service at a repair, never at npx", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.28" },
    "0.0.29",
  );
  expect(output).toContain("Run `s2code service install` to repair it.");
  expect(output).not.toContain("npx");
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd",
  );
});

it("reports a newer installed service and tells the CLI to catch up to it", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31-nightly.1",
  );

  assert.include(output, "s2code@0.0.32-nightly.1 (newer than this s2code@0.0.31-nightly.1 CLI)");
  assert.include(output, "Run `s2code-nightly update 0.0.32-nightly.1` to match it");
  assert.notInclude(output, "npx");
});

it("does not suggest cross-channel update commands as service recovery", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31",
  );
  expect(output).toContain("Install the other channel separately");
  expect(output).not.toContain("s2code update");
});

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };

function makeTestService(
  serviceStatus: BootService.BootServiceStatus,
  restartOutcome: "restarted" | "queued" = "restarted",
) {
  const installOptions: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
  const restarts: Array<true> = [];
  const uninstalls: Array<true> = [];
  const service = BootService.BootService.of({
    status: Effect.succeed(serviceStatus),
    withStopped: (operation) => operation,
    restart: Effect.sync(() => {
      restarts.push(true);
      return serviceStatus.installed ? restartOutcome : "skipped";
    }),
    install: (options) =>
      Effect.sync(() => {
        installOptions.push(options);
        return {
          program: ["/test/t3/runtime/versions/1.0.0/t3", "__service-launcher"],
          baseDir: "/test/t3",
          unitPath: serviceStatus.unitPath,
          logPath: serviceStatus.logPath,
        };
      }),
    uninstall: Effect.sync(() => {
      uninstalls.push(true);
      return serviceStatus.installed;
    }),
  });
  return { service, installOptions, restarts, uninstalls };
}

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("service commands", (it) => {
  it.effect.each(
    (["install", "update"] as const).flatMap((command) => [
      {
        command,
        label: "a downgrade",
        status: newerServiceStatus,
        error: {
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        },
      },
      // This home's newer state must not ask for --allow-downgrade first.
      {
        command,
        label: "another home's service",
        status: { ...newerServiceStatus, otherBaseDir: "/srv/t3" },
        error: { _tag: "BootServiceOtherBaseDirError", installedBaseDir: "/srv/t3" },
      },
    ]),
  )(
    "$command refuses $label before changing the service",
    ({ command, status: serviceStatus, error: expected }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(serviceStatus);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );

        const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.flip,
        );

        expect(error).toMatchObject(expected);
        expect(installOptions).toEqual([]);
      }),
  );

  it.effect.each<{
    readonly label: string;
    readonly installed: boolean;
    readonly before?: "service uninstall" | "full uninstall";
    readonly env: string;
    readonly expected: string;
  }>([
    { label: "a fresh home", installed: false, env: "", expected: "S2CODE_LAN=false\n" },
    // Services installed before S2CODE_LAN existed keep listening on the local network.
    { label: "a reinstall over an older service", installed: true, env: "", expected: "" },
    {
      label: "a reinstall after `service uninstall`",
      installed: false,
      before: "service uninstall",
      env: "",
      expected: "",
    },
    {
      label: "an earlier LAN choice after `service uninstall`",
      installed: false,
      before: "service uninstall",
      env: "S2CODE_LAN=false\n",
      expected: "S2CODE_LAN=false\n",
    },
    {
      label: "a home after a full uninstall",
      installed: false,
      before: "full uninstall",
      env: "",
      expected: "S2CODE_LAN=false\n",
    },
    {
      label: "a saved LAN choice after a full uninstall",
      installed: false,
      before: "full uninstall",
      env: "S2CODE_PORT=4000\nS2CODE_LAN=true\n",
      expected: "S2CODE_PORT=4000\nS2CODE_LAN=false\n",
    },
    {
      label: "a set host",
      installed: false,
      env: "S2CODE_HOST=::\n",
      expected: "S2CODE_HOST=::\n",
    },
    {
      label: "a legacy host",
      installed: false,
      env: "SHUV2CODE_HOST=::\n",
      expected: "SHUV2CODE_HOST=::\n",
    },
    // The fork ignores upstream names in service.env, so they set no host.
    {
      label: "an upstream host",
      installed: false,
      env: "T3CODE_HOST=::\n",
      expected: "T3CODE_HOST=::\nS2CODE_LAN=false\n",
    },
  ])("install keeps $label off the local network only when it is new", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      yield* fs.writeFileString(`${baseDir}/.product-identity`, "s2code\n");
      yield* fs.writeFileString(`${baseDir}/service.env`, input.env);
      const { service } = makeTestService({
        ...status,
        installed: input.installed,
        current: false,
      });
      if (input.before !== undefined) {
        // What `service install` left behind; the unit itself is already gone.
        yield* fs.makeDirectory(`${baseDir}/runtime/versions/1.0.0`, { recursive: true });
        yield* fs.writeFileString(`${baseDir}/runtime/versions/1.0.0/t3`, "");
        yield* fs.writeFileString(`${baseDir}/runtime/service-state.json`, "{}\n");
      }
      if (input.before === "full uninstall") {
        yield* runUninstall({ baseDir, assumeYes: true }).pipe(
          Effect.provideService(BootService.BootService, service),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provide(Layer.fresh(TestConsole.layer)),
        );
        expect(yield* fs.readFileString(`${baseDir}/service.env`)).not.toContain("LAN=");
      }
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "install",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      expect(yield* fs.readFileString(`${baseDir}/service.env`)).toBe(input.expected);
    }),
  );

  it.effect("protect refuses root before creating any T3 directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const baseDir = `${parent}/t3`;
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, makeTestService(status).service),
      );

      const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "protect",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.UserId, 0),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      expect(output).toContain("without sudo");
      expect(yield* fs.exists(baseDir)).toBe(false);
    }),
  );

  // regression: #13239 a stale nvm-installed CLI reported "already using" its own version
  it.effect.each(["install", "update"] as const)(
    "%s names the CLI that found nothing to change",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(status);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );
        const node = "/home/me/.nvm/versions/node/v26.8.2/bin/node";
        const script = "/home/me/.nvm/versions/node/v26.8.2/lib/node_modules/t3/dist/bin.mjs";

        const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.andThen(TestConsole.logLines),
          Effect.map((lines) => lines.join("\n")),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.ExecutablePath, node),
          Effect.provideService(HostProcess.Arguments, [node, script, "service", command]),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              Layer.fresh(TestConsole.layer),
            ),
          ),
        );
        expect(output).toContain(`s2code@${packageJson.version}`);
        expect(output).toContain(script);
        expect(installOptions).toEqual([]);
      }),
  );

  it.effect.each([
    { label: "this home's service", otherHome: false, unreadable: false, removed: [true] },
    { label: "another home's service", otherHome: true, unreadable: false, removed: [] },
    { label: "an unreadable service", otherHome: false, unreadable: true, removed: [true] },
  ])("uninstall removes only $label", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service, uninstalls } = makeTestService({
        ...status,
        installedBaseDir: input.otherHome ? "/home/me/.t3" : baseDir,
      });
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(
          BootService.BootService,
          input.unreadable
            ? {
                ...service,
                status: Effect.fail(new BootService.BootServiceInstallError({ cause: "EACCES" })),
              }
            : service,
        ),
      );

      const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "uninstall",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      expect(uninstalls).toEqual(input.removed);
      expect(output).toContain(input.otherHome ? "--base-dir '/home/me/.t3'" : "Removed");
    }),
  );
});
