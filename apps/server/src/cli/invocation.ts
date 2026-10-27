import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveChannelIdentity,
  resolveLegacyChannelIdentity,
} from "@t3tools/shared/channelIdentity";
import {
  PRODUCT_ID,
  LEGACY_PRODUCT_ID,
  NPM_PACKAGE_NAME,
  isOwnedCliShim,
} from "@t3tools/shared/productIdentity";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/** Detection is best-effort; unknown installs never imply npm ownership. */
function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || /\/bunx-\d+-[^/]+\//.test(path)) {
    return "bunx";
  }
  return null;
}

const InstallManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

const npmPackageBinName = (packageName: typeof NPM_PACKAGE_NAME | typeof LEGACY_PRODUCT_ID) =>
  packageName === NPM_PACKAGE_NAME ? PRODUCT_ID : LEGACY_PRODUCT_ID;

/** Prove the running package and its global bin belong together before suggesting an update. */
const resolveOwnedServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* HostProcess.Arguments;
  const executable = yield* HostProcess.IsExecutable;
  const executablePath = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const entry = yield* fs.realPath(executable ? executablePath : (args[1] ?? ""));
  const match =
    /^(.*)\/lib\/node_modules\/(@s2code\/cli|shuv2code)\/(?:dist\/bin\.mjs|bin\/t3\.js|node_modules\/@(?:s2code|shuv2code)\/t3-[^/]+\/t3)$/.exec(
      entry,
    );
  if (!match) {
    const runner = detectCliRunner(entry);
    return runner === null
      ? null
      : ({ kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner } satisfies ServerInstallation);
  }
  if (platform === "win32") return null;
  const prefix = match[1] || "/";
  if (
    prefix.includes("/node_modules/") ||
    /\/(?:Cellar|Caskroom)\//i.test(prefix) ||
    /\/mise\/installs\/(?!node\/)[^/]+\//.test(prefix)
  )
    return null;

  const packageName = match[2] === NPM_PACKAGE_NAME ? NPM_PACKAGE_NAME : LEGACY_PRODUCT_ID;
  const binName = npmPackageBinName(packageName);
  const packageRoot = path.join(prefix, "lib/node_modules", packageName);
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, "package.json"))
    .pipe(Effect.flatMap(decodeInstallManifest));
  if (manifest.name !== packageName || !manifest.bin?.[binName]) return null;
  const bin = yield* fs.realPath(path.join(packageRoot, manifest.bin[binName]!));
  const globalBin = yield* fs.realPath(path.join(prefix, "bin", binName));
  if (globalBin !== bin) return null;
  if (executable) {
    const nativeManifest = yield* fs
      .readFileString(path.join(path.dirname(entry), "package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest));
    if (
      manifest.bin[binName]! !== "./bin/t3.js" ||
      manifest.optionalDependencies?.[nativeManifest.name] !== nativeManifest.version ||
      nativeManifest.version !== manifest.version
    )
      return null;
  } else if (bin !== entry) {
    return null;
  }
  return { kind: "npm-global", prefix, packageName } as const;
}).pipe(Effect.orElseSucceed(() => null));

export const resolveServerInstallation = resolveOwnedServerInstallation;

/**
 * The fork package spec to suggest. The literal spec the user typed (e.g.
 * `shuv2code@nightly`) is resolved away before our process starts, so re-derive it
 * from the running version: nightly keeps its tag, stable uses the bare package,
 * and preview/PR builds pin their installed version.
 */
function suggestedPackageSpec(version: string): string {
  const channel = resolveChannelIdentity(version).channel;
  // Preview/PR recovery stays on the installed version, never a mutable tag or stable.
  return channel === "preview"
    ? `${NPM_PACKAGE_NAME}@${version}`
    : channel === "nightly"
      ? `${NPM_PACKAGE_NAME}@nightly`
      : NPM_PACKAGE_NAME;
}

export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const runner = detectCliRunner(input.entryPath);
  if (runner === null) {
    return forkCliCommand(input.subcommand, input.version);
  }
  return `${runner} ${suggestedPackageSpec(input.version)} ${input.subcommand}`;
}

/** Safe fallback for messages that have no runtime invocation context. */
export const forkCliCommand = (subcommand: string, version = packageJson.version) =>
  `${resolveChannelIdentity(version).executableName} ${subcommand}`;

/**
 * Proven npm bin, current fork executable/shim, or source runtime and entry;
 * never an unrelated PATH command. `pathCommand` is set when the command starts
 * with a path quoted by `quote`, which PowerShell runs only through `&`.
 */
const resolveCliInvocation = Effect.fnUntraced(function* (
  commandArgs: string,
  quote: (value: string) => string,
) {
  const args = yield* HostProcess.Arguments;
  const entry = args[1] ?? "";
  const installation = yield* resolveOwnedServerInstallation;
  if (installation?.kind === "npm-global") {
    const path = yield* Path.Path;
    return {
      command: `${quote(path.join(installation.prefix, "bin", npmPackageBinName(installation.packageName)))} ${commandArgs}`,
      pathCommand: true,
      launcher: false,
    };
  }
  const runner =
    installation?.kind === "npx"
      ? "npx"
      : installation?.kind === "pnpm-dlx"
        ? "pnpm dlx"
        : installation?.kind === "bunx"
          ? "bunx"
          : detectCliRunner(entry);
  if (runner !== null)
    return {
      command: `${runner} ${suggestedPackageSpec(packageJson.version)} ${commandArgs}`,
      pathCommand: false,
      launcher: false,
    };
  const launcher = yield* resolveInstallLauncher;
  if (Option.isSome(launcher))
    return {
      command: `${quote(launcher.value)} ${commandArgs}`,
      pathCommand: true,
      launcher: true,
    };
  if (entry && !entry.includes(".asar")) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const absoluteEntry = path.resolve(yield* HostProcess.WorkingDirectory, entry);
    const resolvedEntry = yield* fs
      .realPath(absoluteEntry)
      .pipe(Effect.orElseSucceed(() => absoluteEntry));
    return {
      command: `${quote(yield* HostProcess.ExecutablePath)} ${quote(resolvedEntry)} ${commandArgs}`,
      pathCommand: true,
      launcher: false,
    };
  }
  return { command: forkCliCommand(commandArgs), pathCommand: false, launcher: false };
});

/** The fork command for POSIX shells and service files. */
export const resolveCliCommand = Effect.fnUntraced(function* (
  subcommand: string,
  baseDir?: string,
) {
  const commandArgs =
    baseDir === undefined ? subcommand : `${subcommand} ${formatCliHomeFlag(baseDir)}`;
  return (yield* resolveCliInvocation(commandArgs, shellWord)).command;
});

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
export const formatCliHomeFlag = (baseDir: string) => `--base-dir ${shellWord(baseDir)}`;

/** Never offer a package removal command unless ownership of this npm prefix was proven. */
export const resolveUninstallGuidance = Effect.gen(function* () {
  const installation = yield* resolveOwnedServerInstallation;
  if (installation?.kind === "npm-global")
    return `Remove this fork's npm package with \`npm uninstall --global --prefix ${shellWord(installation.prefix)} ${installation.packageName}\`. Your upstream installation is separate.`;
  if (installation !== null)
    return "This is a temporary fork package-runner launch, not a global install. Stop the process; there is no global package to uninstall.";
  return (yield* HostProcess.IsExecutable)
    ? "This standalone fork binary has no other managed installation to remove. Remove only the fork binary you installed if you no longer need it."
    : "This server runs from source or an unrecognized Node installation. Stop that process and undo only its fork setup; keep your checkout and data unless you explicitly want to remove them.";
});

/**
 * A marked fork desktop shim named by internal T3CODE_CLI_PATH, or the running
 * standalone fork binary. Source installs instead use their runtime and entry.
 */
const resolveInstallLauncher = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shim = (yield* HostProcess.Environment).T3CODE_CLI_PATH?.trim();
  if (
    shim &&
    [
      PRODUCT_ID,
      LEGACY_PRODUCT_ID,
      `${LEGACY_PRODUCT_ID}.cmd`,
      resolveLegacyChannelIdentity(packageJson.version).executableName,
      `${resolveLegacyChannelIdentity(packageJson.version).executableName}.cmd`,
      `${PRODUCT_ID}.cmd`,
      "s2c",
      "s2c.cmd",
      resolveChannelIdentity(packageJson.version).executableName,
      `${resolveChannelIdentity(packageJson.version).executableName}.cmd`,
    ].includes(path.basename(shim))
  ) {
    const content = yield* fs.readFileString(shim).pipe(Effect.option);
    if (Option.isSome(content) && isOwnedCliShim(content.value)) return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/** PowerShell also treats typographic quotes as delimiters; escape them and suppress expansion. */
const powershellWord = (value: string) =>
  `"${value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&")}"`;

const hostShellWord = (platform: NodeJS.Platform, value: string) =>
  platform === "win32" ? powershellWord(value) : shellWord(value);

/**
 * The fork command for a person to run on this host, with `args` quoted for the
 * host's shell. `launcher` tracks whether it is a self-contained launcher, so
 * sudo need not preserve a user-installed Node's PATH for it.
 */
export const resolveHostCliCommand = Effect.fnUntraced(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const quote = (value: string) => hostShellWord(platform, value);
  const invocation = yield* resolveCliInvocation(subcommand, quote);
  // PowerShell runs a quoted path only through the call operator.
  const call = platform === "win32" && invocation.pathCommand ? "& " : "";
  return {
    command: [`${call}${invocation.command}`, ...args.map(quote)].join(" "),
    launcher: invocation.launcher,
  };
});

/**
 * `sudo` resets PATH on most distributions, which drops a user-installed Node
 * (nvm, fnm, a tarball) and with it package runners, so the command carries
 * PATH through unless Node is on root's PATH too. An absolute launcher needs
 * neither.
 */
export const resolveRootCliCommand = Effect.fn("invocation.resolveRootCliCommand")(function* (
  subcommand: string,
) {
  const { command, launcher } = yield* resolveHostCliCommand(subcommand);
  if (launcher) return `sudo ${command}`;
  const executablePath = yield* HostProcess.ExecutablePath;
  const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
    executablePath.startsWith(`${directory}/`),
  );
  return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
});

const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
