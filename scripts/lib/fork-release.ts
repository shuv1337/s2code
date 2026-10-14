import { CLI_ARCHIVE_PLATFORM_KEYS, cliArchiveFileName } from "@t3tools/shared/cliRelease";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";

export const FORK_RELEASE_REPOSITORY = "shuv1337/shuv2code";
export const FORK_RELEASE_WORKFLOW = "release.yml";
export const FORK_RELEASE_INDEX_BRANCH = "fork-release-index";
export const FORK_RELEASE_INDEX_URL = `https://raw.githubusercontent.com/${FORK_RELEASE_REPOSITORY}/${FORK_RELEASE_INDEX_BRANCH}/index.json`;

/** The backing store must publish with compare-and-swap, never delete before write. */
export async function publishAtomicReleaseIndex(
  content: string,
  store: {
    read: () => Promise<{ sha: string; content: string } | null>;
    write: (content: string, previousSha: string | undefined) => Promise<void>;
  },
) {
  const previous = await store.read();
  if (previous?.content === content) return;
  await store.write(content, previous?.sha);
  if ((await store.read())?.content !== content)
    throw new Error("Published release index content mismatch.");
}
export const FORK_NPM_PACKAGES = [
  ...CLI_ARCHIVE_PLATFORM_KEYS.map((key) => `@shuv2code/t3-${key}`),
  "shuv2code",
];
export const FORK_DESKTOP_MATRIX = [
  {
    label: "macOS arm64",
    platform: "mac",
    arch: "arm64",
    runner: "macos-15-arm64",
    target: "dmg",
    rust_target: "aarch64-apple-darwin",
    resource_key: "darwin-arm64",
    cli_archive: true,
  },
  {
    label: "macOS x64",
    platform: "mac",
    arch: "x64",
    runner: "macos-15-intel",
    target: "dmg",
    rust_target: "x86_64-apple-darwin",
    resource_key: "darwin-x64",
    cli_archive: false,
  },
  {
    label: "Linux x64",
    platform: "linux",
    arch: "x64",
    runner: "ubuntu-24.04",
    target: "AppImage",
    rust_target: "x86_64-unknown-linux-gnu",
    resource_key: "linux-x64",
    cli_archive: true,
  },
  {
    label: "Linux arm64",
    platform: "linux",
    arch: "arm64",
    runner: "ubuntu-24.04-arm",
    target: "AppImage",
    rust_target: "aarch64-unknown-linux-gnu",
    resource_key: "linux-arm64",
    cli_archive: true,
  },
  {
    label: "Windows x64",
    platform: "win",
    arch: "x64",
    runner: "windows-2025",
    target: "nsis",
    rust_target: "x86_64-pc-windows-msvc",
    resource_key: "win32-x64",
    cli_archive: true,
  },
  {
    label: "Windows arm64",
    platform: "win",
    arch: "arm64",
    runner: "windows-11-arm",
    target: "nsis",
    rust_target: "aarch64-pc-windows-msvc",
    resource_key: "win32-arm64",
    cli_archive: true,
  },
] as const;
export const MAC_RELEASE_CREDENTIALS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_TEAM_ID",
];
export const WIN_RELEASE_CREDENTIALS = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
];
type Environment = Readonly<Record<string, string | undefined>>;
export function releaseSigningPolicy(channel: string, allowUnsigned: boolean, env: Environment) {
  if (!["stable", "nightly", "preview"].includes(channel))
    throw new Error("Unsupported fork release channel.");
  if (channel === "stable" && allowUnsigned)
    throw new Error("Stable releases cannot opt into unsigned publication.");
  const missingMac = MAC_RELEASE_CREDENTIALS.filter((key) => !env[key]?.trim());
  const missingWin = WIN_RELEASE_CREDENTIALS.filter((key) => !env[key]?.trim());
  if ((!allowUnsigned || channel === "stable") && (missingMac.length || missingWin.length))
    throw new Error(
      `Missing fork signing configuration: ${[...missingMac, ...missingWin].join(", ")}. Only nightly/preview can explicitly allow_unsigned.`,
    );
  return {
    mac: missingMac.length === 0,
    win: missingWin.length === 0,
    unsigned: missingMac.length > 0 || missingWin.length > 0,
  };
}
export function forkReleasePlan(input: {
  repository: string;
  sha: string;
  version: string;
  channel: string;
  signing: ReturnType<typeof releaseSigningPolicy>;
}) {
  if (input.repository !== FORK_RELEASE_REPOSITORY)
    throw new Error("Release publication is restricted to the fork repository.");
  if (!/^[a-f0-9]{40}$/i.test(input.sha))
    throw new Error("One exact release source commit is required.");
  if (
    [input.signing.mac, input.signing.win, input.signing.unsigned].some(
      (value) => typeof value !== "boolean",
    ) ||
    input.signing.unsigned !== (!input.signing.mac || !input.signing.win)
  )
    throw new Error("Invalid release signing policy.");
  if (
    !/^\d+\.\d+\.\d+(?:-(?:nightly|preview)\.\d{8}\.\d+)?$/.test(input.version) ||
    resolveChannelIdentity(input.version).channel !== input.channel
  )
    throw new Error("Release version does not match its installation channel.");
  if (input.channel === "stable" && input.signing.unsigned)
    throw new Error("Unsigned stable publication is prohibited.");
  return {
    ...input,
    tag: `v${input.version}`,
    distTag: input.channel === "stable" ? "latest" : input.channel,
    stagingTag: `release-${input.sha.slice(0, 12)}-${input.version}`,
    title: `${input.signing.unsigned ? "UNSIGNED — " : ""}shuv2code ${input.channel} v${input.version}`,
    cliAssets: CLI_ARCHIVE_PLATFORM_KEYS.map((key) => cliArchiveFileName(input.version, key)),
    feedAssets:
      input.channel === "preview"
        ? []
        : [
            `${input.channel === "stable" ? "latest" : "nightly"}-mac.yml`,
            `${input.channel === "stable" ? "latest" : "nightly"}-linux.yml`,
            `${input.channel === "stable" ? "latest" : "nightly"}-linux-arm64.yml`,
            `${input.channel === "stable" ? "latest" : "nightly"}.yml`,
          ],
  };
}
export type ForkReleasePlan = ReturnType<typeof forkReleasePlan>;

export function desktopAssetGroups(version: string) {
  return FORK_DESKTOP_MATRIX.flatMap((target) => {
    const extensions =
      target.platform === "mac"
        ? ["dmg", "zip"]
        : target.platform === "linux"
          ? ["AppImage", "deb"]
          : ["exe"];
    return extensions.map((extension) => {
      const aliases =
        target.platform === "linux" && target.arch === "x64"
          ? extension === "deb"
            ? ["amd64", "x64"]
            : ["x86_64", "x64"]
          : [target.arch];
      return aliases.map((arch) => `T3-Code-${version}-${arch}.${extension}`);
    });
  });
}
export function requiredDesktopAssets(version: string, names: ReadonlyArray<string>) {
  return desktopAssetGroups(version).map((group) => {
    const found = group.filter((name) => names.includes(name));
    if (found.length !== 1)
      throw new Error(`Expected exactly one desktop asset: ${group.join(" or ")}.`);
    return found[0]!;
  });
}
export function assertForkNpmManifest(value: unknown, version: string) {
  const manifest = value as {
    name?: string;
    version?: string;
    private?: boolean;
    repository?: { url?: string };
    optionalDependencies?: Record<string, string>;
  };
  const repository = manifest.repository?.url
    ?.replace(/^git\+/, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
  if (
    !manifest.name ||
    !FORK_NPM_PACKAGES.includes(manifest.name) ||
    manifest.name === "t3" ||
    manifest.private === true ||
    manifest.version !== version ||
    repository !== `https://github.com/${FORK_RELEASE_REPOSITORY}`
  )
    throw new Error(
      "Refusing publication outside the exact fork package/version/repository allowlist.",
    );
  if (manifest.name === "shuv2code") {
    const expected = FORK_NPM_PACKAGES.filter((name) => name !== "shuv2code");
    if (
      Object.keys(manifest.optionalDependencies ?? {}).length !== expected.length ||
      expected.some((name) => manifest.optionalDependencies?.[name] !== version)
    )
      throw new Error("Launcher must depend on all five exact matching fork platform versions.");
  }
  return manifest as {
    name: string;
    version: string;
    repository: { url: string };
    optionalDependencies?: Record<string, string>;
  };
}
export function assertForkNpmSet(manifests: ReadonlyArray<unknown>, version: string) {
  const checked = manifests.map((manifest) => assertForkNpmManifest(manifest, version));
  if (
    checked.length !== FORK_NPM_PACKAGES.length ||
    new Set(checked.map((manifest) => manifest.name)).size !== FORK_NPM_PACKAGES.length
  )
    throw new Error("All five platform packages and the launcher are required.");
  return checked;
}
export function assertForkDistTag(version: string, tag: string) {
  if (!/^\d+\.\d+\.\d+(?:-(?:nightly|preview)\.\d{8}\.\d+)?$/.test(version))
    throw new Error("Invalid fork release version.");
  const channel = resolveChannelIdentity(version).channel;
  const expected = channel === "stable" ? "latest" : channel;
  if (
    tag !== expected &&
    !new RegExp(`^release-[a-f0-9]{12}-${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(
      tag,
    )
  )
    throw new Error(
      "npm dist-tag must match the fork installation channel or its private release staging tag.",
    );
}
/** #272 consumes this tag_name/draft shape. Preview and incomplete/draft releases never enter it. */
export function forkReleaseIndex(
  releases: ReadonlyArray<{
    tag_name: string;
    draft?: boolean;
    assets?: ReadonlyArray<{ name: string }>;
  }>,
) {
  return releases
    .filter((release) => {
      const version = release.tag_name.replace(/^v/, "");
      if (release.draft || !/^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(version)) return false;
      const names = release.assets?.map((asset) => asset.name) ?? [];
      try {
        requiredDesktopAssets(version, names);
      } catch {
        return false;
      }
      const prefix = resolveChannelIdentity(version).channel === "stable" ? "latest" : "nightly";
      return [
        ...CLI_ARCHIVE_PLATFORM_KEYS.map((key) => cliArchiveFileName(version, key)),
        "SHA256SUMS",
        "release.json",
        `${prefix}-mac.yml`,
        `${prefix}-linux.yml`,
        `${prefix}-linux-arm64.yml`,
        `${prefix}.yml`,
      ].every((name) => names.includes(name));
    })
    .map((release) => ({ tag_name: release.tag_name, draft: false }));
}
export async function publishForkReleaseSequence(operations: {
  ensureDraft: () => Promise<void>;
  uploadBinaries: () => Promise<void>;
  verifyBinaries: () => Promise<void>;
  publishNpm: () => Promise<void>;
  verifyNpm: () => Promise<void>;
  uploadFeeds: () => Promise<void>;
  verifyCompleteRelease: () => Promise<void>;
  publishRelease: () => Promise<void>;
  promoteNpmTags: () => Promise<void>;
  publishIndex: () => Promise<void>;
}) {
  await operations.ensureDraft();
  await operations.uploadBinaries();
  await operations.verifyBinaries();
  await operations.publishNpm();
  await operations.verifyNpm();
  await operations.uploadFeeds();
  await operations.verifyCompleteRelease();
  await operations.publishRelease();
  await operations.promoteNpmTags();
  await operations.publishIndex();
}
