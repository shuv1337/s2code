import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Console from "effect/Console";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import * as ServerConfig from "../config.ts";
import { formatCliCommand, formatCliHomeFlag, resolveCliCommand } from "./invocation.ts";
import {
  formatServiceStatus,
  offerServiceDuringOnboarding,
  recoverServiceOnboardingOffer,
  serviceCommand,
} from "./service.ts";

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
      "  Status: installed · shuv2code@0.0.29",
      "  Unit: /home/me/.config/systemd/user/t3code.service",
      "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `shuv2code service install` to repair it.",
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
  expect(output).toContain("Run `shuv2code-nightly service install` to repair it.");
  expect(output).not.toContain("npx");
});

it("points an older service at a repair, never at npx", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.28" },
    "0.0.29",
  );
  expect(output).toContain("Run `shuv2code service install` to repair it.");
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

  assert.include(
    output,
    "shuv2code@0.0.32-nightly.1 (newer than this shuv2code@0.0.31-nightly.1 CLI)",
  );
  assert.include(output, "Run `shuv2code-nightly update 0.0.32-nightly.1` to match it");
  assert.notInclude(output, "npx");
});

it("does not suggest cross-channel update commands as service recovery", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31",
  );
  expect(output).toContain("Install the other channel separately");
  expect(output).not.toContain("shuv2code update");
});

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };

function makeTestService(
  serviceStatus: BootService.BootServiceStatus,
  restartOutcome: "restarted" | "queued" = "restarted",
) {
  const installOptions: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
  const restarts: Array<true> = [];
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
    uninstall: Effect.succeed(false),
  });
  return { service, installOptions, restarts };
}

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("service commands", (it) => {
  it.effect.each(["install", "update"] as const)(
    "%s refuses a downgrade before changing the service",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(newerServiceStatus);
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

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        });
        expect(installOptions).toEqual([]);
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
});

it.effect("leaves a newer service unchanged during onboarding without prompting", () =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(newerServiceStatus);
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("Onboarding must not prompt to replace a newer service."),
      readLine: Effect.die("Onboarding must not prompt to replace a newer service."),
      display: () => Effect.die("Onboarding must not prompt to replace a newer service."),
    });

    const ready = yield* offerServiceDuringOnboarding.pipe(
      Effect.provideService(BootService.BootService, service),
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(
        ServerConfig.layerTest("/test", { prefix: "service-onboarding-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

    expect(ready).toBe("skipped");
    expect(installOptions).toEqual([]);
  }),
);

it.effect.each([
  {
    entry: "/fork source/apps/server/src/bin.ts",
    prefix: "/runtime/node '/fork source/apps/server/src/bin.ts'",
  },
  { entry: "/home/me/.npm/_npx/fixture/node_modules/shuv2code/dist/bin.mjs", prefix: null },
])(
  "keeps onboarding repair instructions on the launching invocation and custom home ($entry)",
  ({ entry, prefix }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const { service, installOptions } = makeTestService({
        ...newerServiceStatus,
        problems: ["service-disabled", "service-stopped", "restart-pending"],
      });
      const warnings: string[] = [];
      const ready = yield* offerServiceDuringOnboarding.pipe(
        Effect.provideService(BootService.BootService, service),
        Effect.provideService(Console.Console, {
          ...globalThis.console,
          warn: (...args) => {
            warnings.push(args.join(" "));
          },
        }),
      );
      const actualPrefix = (yield* resolveCliCommand("")).trimEnd();
      expect(actualPrefix).toBe(
        prefix ??
          formatCliCommand({
            entryPath: entry,
            version: packageJson.version,
            subcommand: "",
          }).trimEnd(),
      );
      expect(warnings).toHaveLength(3);
      expect(warnings[0]).toContain(
        `\`${actualPrefix} service install ${formatCliHomeFlag(config.baseDir)}\``,
      );
      expect(warnings[1]).toContain(
        `\`${actualPrefix} service install ${formatCliHomeFlag(config.baseDir)}\``,
      );
      expect(warnings[2]).toContain(
        `\`${actualPrefix} service restart ${formatCliHomeFlag(config.baseDir)}\``,
      );
      expect(ready).toBe("skipped");
      expect(installOptions).toEqual([]);
    }).pipe(
      Effect.provide(ServerConfig.layerTest("/fork source", { prefix: "custom service home " })),
      Effect.provideService(HostProcess.Arguments, ["/runtime/node", entry]),
      Effect.provideService(HostProcess.ExecutablePath, "/runtime/node"),
      Effect.provideService(HostProcess.InvokedAs, ""),
      Effect.provideService(HostProcess.IsExecutable, false),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provide(NodeServices.layer),
    ),
);

// regression: #9602 diagnose incomplete headless server setup
it.effect("keeps the manual-server fallback when background prerequisites fail", () =>
  Effect.gen(function* () {
    const ready = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServicePrerequisiteError({ problem: "linger-disabled" })),
    );
    expect(ready).toBe("skipped");
  }),
);
