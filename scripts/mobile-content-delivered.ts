// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- CI Git-tree comparison; no runtime app dependency or release side effect.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const git = (repository: string, args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Compare committed inputs, not env:pull/generated eas.json files in the CI working tree. */
export function mobileContentPaths(repository: string) {
  const manifest = (directory: string) =>
    JSON.parse(git(repository, ["show", `HEAD:${directory}/package.json`])) as Manifest;
  const packages = new Map<string, { directory: string; manifest: Manifest }>();
  for (const directory of git(repository, ["ls-tree", "-d", "--name-only", "HEAD:packages"])
    .split("\n")
    .filter(Boolean)) {
    const relative = `packages/${directory}`;
    // Some workspace roots are native packages, not npm manifests.
    if (
      NodeChildProcess.spawnSync("git", ["cat-file", "-e", `HEAD:${relative}/package.json`], {
        cwd: repository,
        stdio: "ignore",
      }).status !== 0
    )
      continue;
    const value = manifest(relative);
    packages.set(value.name, { directory: relative, manifest: value });
  }
  const paths = new Set([
    "apps/mobile",
    "packages/watch-native",
    "assets",
    "patches",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "tsconfig.base.json",
    // Expo config and Metro import these directly, outside workspace packages.
    "scripts/lib/brand-assets.ts",
    "scripts/lib/public-config.ts",
    "scripts/lib/mobile-release-identity.ts",
    "scripts/lib/third-party-licenses.ts",
    "third-party-licenses.config.json",
    "apps/server/src/device/deviceToolVersions.json",
  ]);
  const visit = (value: Manifest, appBuildTools = false) => {
    for (const [name, specifier] of Object.entries({
      ...value.dependencies,
      ...(appBuildTools ? value.devDependencies : {}),
      ...value.optionalDependencies,
      ...value.peerDependencies,
    })) {
      if (!specifier.startsWith("workspace:")) continue;
      const dependency = packages.get(name);
      if (!dependency) throw new Error("Cannot resolve a mobile workspace input.");
      if (paths.has(dependency.directory)) continue;
      paths.add(dependency.directory);
      visit(dependency.manifest);
    }
  };
  // App build tools matter; workspace libraries' development-only test helpers do not.
  visit(manifest("apps/mobile"), true);
  return [...paths];
}

/** A finished fingerprint/version-matching EAS binary must record a verifiable source commit. */
export function mobileContentDelivered(repository: string, buildCommits: ReadonlyArray<string>) {
  const head = git(repository, ["rev-parse", "HEAD"]);
  const commits = buildCommits.filter((commit) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit));
  if (commits.includes(head)) return true;
  const paths = mobileContentPaths(repository);
  return commits.some((commit) => {
    const known = NodeChildProcess.spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: repository,
      stdio: "ignore",
    });
    if (known.status !== 0) return false;
    return (
      NodeChildProcess.spawnSync("git", ["diff", "--quiet", commit, "HEAD", "--", ...paths], {
        cwd: repository,
        stdio: "ignore",
      }).status === 0
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    const repository = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    process.exitCode = mobileContentDelivered(repository, process.argv.slice(2)) ? 0 : 1;
  } catch {
    console.error("Could not verify mobile content against the matching binary's source revision.");
    process.exitCode = 1;
  }
}
