// @effect-diagnostics nodeBuiltinImport:off
// Windows cleanup must outlive this executable to delete its directory; scoped ChildProcess kills children on exit.
import * as NodeChildProcess from "node:child_process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as BootService from "../cloud/bootService.ts";
import {
  generatedWindowsShimTarget,
  isVersionExecutable,
  launcherOwnsVersionsDir,
  pinnedRuntimeVersionsDir,
} from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";
import { resolveServerInstallation, resolveUninstallGuidance } from "./invocation.ts";
import {
  resolveChannelIdentity,
  resolveLegacyChannelIdentity,
} from "@t3tools/shared/channelIdentity";
import packageJson from "../../package.json" with { type: "json" };
import { findWindowsShim, readLauncherTarget, resolveLauncherPath } from "./update.ts";
import { windowsForwarderShim } from "./windowsForwarderShim.ts";

export class CliUninstallError extends Schema.TaggedError<CliUninstallError>()(
  "CliUninstallError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface UninstallPlan {
  readonly service: boolean;
  readonly versionsDir: string;
  readonly launchers: ReadonlyArray<string>;
  readonly runtimeDir: string | undefined;
  /** `service.env` opens this home to the network, which the next install must not inherit. */
  readonly networkSettings: string | undefined;
  readonly userdataDir: string;
}

const NETWORK_SETTINGS = ["S2CODE_LAN", "SHUV2CODE_LAN", "S2CODE_HOST", "SHUV2CODE_HOST"] as const;

/** Delete only launchers targeting this home's runtime/versions. */
export const findOwnedLauncher = Effect.fn("cli.uninstall.find_launcher")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
  readonly version?: string;
}) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  if (input.launchedAs === undefined) return undefined;
  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs, input.version);
    if (shimPath === undefined) return undefined;
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(shimPath).pipe(Effect.orElseSucceed(() => ""));
    const legacy = path.join(
      path.dirname(shimPath),
      `${resolveLegacyChannelIdentity(input.version ?? packageJson.version).executableName}.cmd`,
    );
    if (
      generatedWindowsShimTarget(contents) === undefined &&
      contents !== windowsForwarderShim(legacy)
    )
      return undefined;
    const target = (yield* readLauncherTarget(shimPath, input.version))?.target;
    return target !== undefined && launcherOwnsVersionsDir(path, input.versionsDir, target)
      ? shimPath
      : undefined;
  }
  if (
    ![
      resolveChannelIdentity(input.version ?? packageJson.version).executableName,
      resolveLegacyChannelIdentity(input.version ?? packageJson.version).executableName,
      "s2c",
    ].includes(path.basename(input.launchedAs))
  )
    return undefined;
  const target = (yield* readLauncherTarget(input.launchedAs, input.version))?.target;
  return target !== undefined && launcherOwnsVersionsDir(path, input.versionsDir, target)
    ? input.launchedAs
    : undefined;
});

/** Whether `launcher` is a link or unedited `t3.cmd` into this home's runtime/versions. */
const ownsLauncher = Effect.fn("cli.uninstall.owns_launcher")(function* (
  launcher: string,
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const realVersionsDir = yield* fs
    .realPath(versionsDir)
    .pipe(Effect.orElseSucceed(() => versionsDir));
  // The link's own text keeps a pruned (dangling) target; the real path sees through a
  // symlinked T3 home.
  const targets =
    platform === "win32"
      ? [
          yield* fs.readFileString(launcher).pipe(
            Effect.map(generatedWindowsShimTarget),
            Effect.orElseSucceed(() => undefined),
          ),
        ]
      : [
          yield* fs.readLink(launcher).pipe(
            Effect.map((link) => path.resolve(path.dirname(launcher), link)),
            Effect.orElseSucceed(() => undefined),
          ),
          yield* fs.realPath(launcher).pipe(Effect.orElseSucceed(() => undefined)),
        ];
  return targets.some(
    (target) =>
      target !== undefined &&
      (isVersionExecutable(path, versionsDir, target) ||
        isVersionExecutable(path, realVersionsDir, target)),
  );
});

/**
 * Launchers recorded in `runtime/launchers` by the install scripts and `t3 install` that still
 * point into this home's runtime/versions. npx can run a different version than the installed
 * one, so the launcher this process started from does not always name them.
 */
export const findRecordedLaunchers = Effect.fn("cli.uninstall.find_recorded_launchers")(function* (
  versionsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recorded = yield* fs
    .readFileString(path.join(path.dirname(versionsDir), "launchers"))
    .pipe(Effect.orElseSucceed(() => ""));
  const owned: Array<string> = [];
  for (const launcher of recorded.split(/\r?\n/).filter(Boolean)) {
    if (yield* ownsLauncher(launcher, versionsDir)) owned.push(launcher);
  }
  return owned;
});

// cmd.exe needs verbatim quoting and a literal path, with delayed expansion disabled.
export function spawnWindowsRemoval(comspec: string, dir: string) {
  return NodeChildProcess.spawn(
    comspec,
    [
      "/d",
      "/v:off",
      "/s",
      "/c",
      '"ping -n 3 127.0.0.1 >nul & rmdir /s /q "%T3_UNINSTALL_RUNTIME%""',
    ],
    {
      env: { ...process.env, T3_UNINSTALL_RUNTIME: dir },
      windowsVerbatimArguments: true,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const identities = [
    resolveChannelIdentity(packageJson.version),
    resolveLegacyChannelIdentity(packageJson.version),
  ];
  const ownsUnit =
    status.unitPath !== undefined &&
    identities
      .flatMap((identity) => [`${identity.serviceName}.service`, `${identity.serviceLabel}.plist`])
      .includes(path.basename(status.unitPath));
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = (yield* HostProcess.IsExecutable) ? yield* resolveLauncherPath : undefined;
  const launcher = yield* findOwnedLauncher({ launchedAs, versionsDir });
  const launchers = launcher === undefined ? [] : [launcher];
  if (launcher !== undefined) {
    const platform = yield* HostProcess.Platform;
    for (const name of new Set([...identities.map((identity) => identity.executableName), "s2c"])) {
      const candidate = path.join(
        path.dirname(launcher),
        `${name}${platform === "win32" ? ".cmd" : ""}`,
      );
      if (launchers.includes(candidate)) continue;
      if (platform === "win32") {
        const target = (yield* readLauncherTarget(candidate))?.target;
        if (target !== undefined && launcherOwnsVersionsDir(path, versionsDir, target)) {
          launchers.push(candidate);
        }
      } else if (yield* findOwnedLauncher({ launchedAs: candidate, versionsDir })) {
        launchers.push(candidate);
      }
    }
  }
  const serviceEnv = yield* CliService.readServiceEnv(input.baseDir);
  const plan: UninstallPlan = {
    service: status.supported && status.installed && servesThisHome && ownsUnit,
    versionsDir,
    launchers: [...new Set([...launchers, ...(yield* findRecordedLaunchers(versionsDir))])],
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    networkSettings: NETWORK_SETTINGS.some((key) => Object.hasOwn(serviceEnv.entries, key))
      ? serviceEnv.path
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
  };
  return plan;
});

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove this fork installation: its background service, launcher, and downloaded versions. Your projects and threads are kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({ baseDir: config.baseDir, assumeYes: flags.yes }).pipe(
        Effect.provide(CliService.layer(config)),
      );
    }),
  ),
);

export const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir });

  if (
    !plan.service &&
    plan.launchers.length === 0 &&
    plan.runtimeDir === undefined &&
    plan.networkSettings === undefined
  ) {
    yield* Console.log(`Nothing to remove: s2code is not installed for ${input.baseDir}.`);
    yield* Console.log(`  ${yield* resolveUninstallGuidance}`);
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  for (const launcher of plan.launchers) yield* Console.log(`  the launcher at ${launcher}`);
  if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
  }
  if (plan.networkSettings !== undefined) {
    yield* Console.log(
      `  the local network and host settings in ${plan.networkSettings}, so a new install starts on this machine only`,
    );
  }
  yield* Console.log(
    `Your projects, threads, and settings under ${plan.userdataDir} are kept. Delete that directory yourself if you want them gone too.`,
  );

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({
        message: "Remove this s2code installation from this machine?",
        initial: false,
      }),
    ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  for (const launcher of plan.launchers) {
    // The prompt can wait a long time; never delete a file that replaced the launcher meanwhile.
    if (!(yield* ownsLauncher(launcher, plan.versionsDir))) {
      yield* Console.log(`Left ${launcher}: it no longer runs this s2code.`);
      continue;
    }
    yield* fs
      .remove(launcher, { force: true })
      .pipe(
        Effect.mapError(
          () => new CliUninstallError({ reason: `Could not remove the launcher at ${launcher}.` }),
        ),
      );
    yield* Console.log(`Removed ${launcher}.`);
  }
  if (plan.runtimeDir !== undefined) {
    // Windows refuses to unlink this running executable; a detached shell removes it after exit.
    if (platform === "win32") {
      const runtimeDir = plan.runtimeDir;
      const comspec = environment["ComSpec"] ?? environment["COMSPEC"] ?? "cmd.exe";
      yield* Effect.try({
        try: () => spawnWindowsRemoval(comspec, runtimeDir).unref(),
        catch: () =>
          new CliUninstallError({
            reason: `Could not schedule removal of ${runtimeDir}. Delete it yourself once this window is closed.`,
          }),
      });
      yield* Console.log(`${runtimeDir} will be removed once s2code exits.`);
    } else {
      yield* fs
        .remove(plan.runtimeDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            () => new CliUninstallError({ reason: `Could not remove ${plan.runtimeDir}.` }),
          ),
        );
      yield* Console.log(`Removed ${plan.runtimeDir}.`);
    }
  }
  if (plan.networkSettings !== undefined) {
    yield* CliService.writeServiceEnv(
      input.baseDir,
      Object.fromEntries(NETWORK_SETTINGS.map((key) => [key, undefined])),
    ).pipe(
      Effect.mapError(
        () => new CliUninstallError({ reason: `Could not update ${plan.networkSettings}.` }),
      ),
    );
    yield* Console.log(`Reset the local network and host settings in ${plan.networkSettings}.`);
  }
  yield* Console.log("");
  yield* Console.log(
    "This s2code installation is uninstalled. Upstream and other channels are unchanged.",
  );
  if (
    !(yield* HostProcess.IsExecutable) ||
    (yield* resolveServerInstallation)?.kind === "npm-global"
  )
    yield* Console.log(yield* resolveUninstallGuidance);
});
