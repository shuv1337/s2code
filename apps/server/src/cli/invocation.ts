import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";
import { PRODUCT_ID, PRODUCT_CLI_SHIM_MARKER } from "@t3tools/shared/productIdentity";

import packageJson from "../../package.json" with { type: "json" };

export type CliRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort; unknown installs never imply npm ownership.
 */
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
  bin: Schema.optionalKey(Schema.Struct({ shuv2code: Schema.String })),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

/** Prove the running package and its global bin belong together before suggesting an update. */
export const resolveServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* HostProcess.Arguments;
  const executable = yield* HostProcess.IsExecutable;
  const executablePath = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const entry = yield* fs.realPath(executable ? executablePath : (args[1] ?? ""));
  const match =
    /^(.*)\/lib\/node_modules\/shuv2code\/(?:dist\/bin\.mjs|bin\/t3\.js|node_modules\/@shuv2code\/t3-[^/]+\/t3)$/.exec(
      entry,
    );
  if (!match) {
    const runner = detectCliRunner(entry);
    return runner === null
      ? null
      : ({ kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner } satisfies ServerInstallation);
  }
  // A global prefix can contain runner-like names; prove its ownership first.
  // Windows shims and other package managers need their own ownership proof.
  if (platform === "win32") return null;
  const prefix = match[1] || "/";
  if (
    prefix.includes("/node_modules/") ||
    /\/(?:Cellar|Caskroom)\//i.test(prefix) ||
    /\/mise\/installs\/(?!node\/)[^/]+\//.test(prefix)
  )
    return null;

  const packageRoot = path.join(prefix, "lib/node_modules/shuv2code");
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, "package.json"))
    .pipe(Effect.flatMap(decodeInstallManifest));
  if (manifest.name !== "shuv2code" || !manifest.bin) return null;
  const bin = yield* fs.realPath(path.join(packageRoot, manifest.bin.shuv2code));
  const globalBin = yield* fs.realPath(path.join(prefix, "bin/shuv2code"));
  if (globalBin !== bin) return null;
  if (executable) {
    const nativeManifest = yield* fs
      .readFileString(path.join(path.dirname(entry), "package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest));
    if (
      manifest.bin.shuv2code !== "./bin/t3.js" ||
      manifest.optionalDependencies?.[nativeManifest.name] !== nativeManifest.version ||
      nativeManifest.version !== manifest.version
    )
      return null;
  } else if (bin !== entry) {
    return null;
  }
  return { kind: "npm-global", prefix } satisfies ServerInstallation;
}).pipe(Effect.orElseSucceed(() => null));

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
    ? `${PRODUCT_ID}@${version}`
    : channel === "nightly"
      ? `${PRODUCT_ID}@nightly`
      : PRODUCT_ID;
}

/**
 * Render a context-free fork command: runner paths keep their package runner
 * and channel tag; other paths use the channel-owned command name.
 */
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

/** Proven npm bin, current fork executable/shim, or source runtime and entry; never an unrelated PATH command. */
export const resolveCliCommand = Effect.fnUntraced(function* (
  subcommand: string,
  baseDir?: string,
) {
  const commandArgs =
    baseDir === undefined ? subcommand : `${subcommand} ${formatCliHomeFlag(baseDir)}`;
  const args = yield* HostProcess.Arguments;
  const entry = args[1] ?? "";
  const installation = yield* resolveServerInstallation;
  if (installation?.kind === "npm-global") {
    const path = yield* Path.Path;
    return `${shellWord(path.join(installation.prefix, "bin", PRODUCT_ID))} ${commandArgs}`;
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
    return `${runner} ${suggestedPackageSpec(packageJson.version)} ${commandArgs}`;
  const launcher = yield* resolveInstallLauncher;
  if (Option.isSome(launcher)) return `${shellWord(launcher.value)} ${commandArgs}`;
  if (entry && !entry.includes(".asar"))
    return `${shellWord(yield* HostProcess.ExecutablePath)} ${shellWord(entry)} ${commandArgs}`;
  return forkCliCommand(commandArgs);
});

/** Quotes `value` for a POSIX shell when it needs it. */
const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
export const formatCliHomeFlag = (baseDir: string) => `--base-dir ${shellWord(baseDir)}`;

/** Never offer a package removal command unless ownership of this npm prefix was proven. */
export const resolveUninstallGuidance = Effect.gen(function* () {
  const installation = yield* resolveServerInstallation;
  if (installation?.kind === "npm-global")
    return `Remove this fork's npm package with \`npm uninstall --global --prefix ${shellWord(installation.prefix)} ${PRODUCT_ID}\`. Your upstream installation is separate.`;
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
      `${PRODUCT_ID}.cmd`,
      resolveChannelIdentity(packageJson.version).executableName,
      `${resolveChannelIdentity(packageJson.version).executableName}.cmd`,
    ].includes(path.basename(shim))
  ) {
    const content = yield* fs.readFileString(shim).pipe(Effect.option);
    if (Option.isSome(content) && content.value.includes(PRODUCT_CLI_SHIM_MARKER))
      return Option.some(shim);
  }
  return (yield* HostProcess.IsExecutable)
    ? Option.some(yield* HostProcess.ExecutablePath)
    : Option.none<string>();
});

/**
 * Track whether the rendered command is a self-contained launcher, so sudo
 * need not preserve a user-installed Node's PATH for it.
 */
const resolveHostCliCommand = Effect.fnUntraced(function* (subcommand: string) {
  const command = yield* resolveCliCommand(subcommand);
  const launcher = yield* resolveInstallLauncher;
  return {
    command,
    launcher: Option.isSome(launcher) && command === `${shellWord(launcher.value)} ${subcommand}`,
  };
});

/**
 * Fork setup as root, for an operation a person runs once on the host. `sudo`
 * resets PATH on most distributions, which drops a user-installed Node (nvm,
 * fnm, a tarball) and with it package runners, so the command carries
 * PATH through unless Node is on root's PATH too. An absolute launcher needs
 * neither.
 */
export const resolveRootCliCommand = (subcommand: string) =>
  Effect.gen(function* () {
    const { command, launcher } = yield* resolveHostCliCommand(subcommand);
    if (launcher) return `sudo ${command}`;
    const executablePath = yield* HostProcess.ExecutablePath;
    const systemNode = ROOT_PATH_DIRECTORIES.some((directory) =>
      executablePath.startsWith(`${directory}/`),
    );
    return systemNode ? `sudo ${command}` : `sudo env "PATH=$PATH" ${command}`;
  });

/** Debian and Ubuntu's sudo `secure_path`, minus snap. */
const ROOT_PATH_DIRECTORIES = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
];
