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
import { launcherOwnsVersionsDir, pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";
import { resolveServerInstallation, resolveUninstallGuidance } from "./invocation.ts";
import {
  resolveChannelIdentity,
  resolveLegacyChannelIdentity,
} from "@t3tools/shared/channelIdentity";
import packageJson from "../../package.json" with { type: "json" };
import { findWindowsShim, readLauncherTarget, resolveLauncherPath } from "./update.ts";

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
  readonly launchers: ReadonlyArray<string>;
  readonly runtimeDir: string | undefined;
  readonly userdataDir: string;
}

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
  const plan: UninstallPlan = {
    service: status.supported && status.installed && servesThisHome && ownsUnit,
    launchers,
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
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

  if (!plan.service && plan.launchers.length === 0 && plan.runtimeDir === undefined) {
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
        try: () => {
          const child = NodeChildProcess.spawn(
            comspec,
            ["/d", "/c", `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${runtimeDir}"`],
            { detached: true, stdio: "ignore", windowsHide: true },
          );
          child.unref();
        },
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
