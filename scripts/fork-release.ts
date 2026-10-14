// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off -- Guarded release CLI boundary; publishing is reachable only with explicit CI execution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import { CLI_ARCHIVE_PLATFORM_KEYS, cliArchiveFileName } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  FORK_RELEASE_REPOSITORY,
  FORK_DESKTOP_MATRIX,
  FORK_NPM_PACKAGES,
  releaseSigningPolicy,
  forkReleasePlan,
  requiredDesktopAssets,
  assertForkNpmSet,
  assertForkNpmManifest,
  forkReleaseIndex,
  publishForkReleaseSequence,
  type ForkReleasePlan,
} from "./lib/fork-release.ts";
import {
  parseUpdateManifest,
  mergeUpdateManifests,
  serializeUpdateManifest,
} from "./lib/update-manifest.ts";
const FS = NodeFS;
const Path = NodePath;
const URL = NodeURL;
const Crypto = NodeCrypto;
const CP = NodeChildProcess;

const run = (command: string, args: string[], cwd?: string) =>
  CP.execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const runAsync = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = CP.spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", () => reject(new Error("Release command could not start.")));
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Fork npm publication failed. Check exact release.yml trusted-publisher configuration and allowed actions.",
            ),
          ),
    );
  });
const digest = (file: string, algorithm = "sha256", encoding: "hex" | "base64" = "hex") =>
  Crypto.createHash(algorithm).update(FS.readFileSync(file)).digest(encoding);
const writeJson = (file: string, value: unknown) =>
  FS.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const readPlan = (file = "release-plan.json") => {
  const value = JSON.parse(FS.readFileSync(file, "utf8")) as ForkReleasePlan;
  return forkReleasePlan(value);
};
function assertCi() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== FORK_RELEASE_REPOSITORY ||
    !process.env.GITHUB_WORKFLOW_REF?.startsWith(
      `${FORK_RELEASE_REPOSITORY}/.github/workflows/release.yml@`,
    )
  )
    throw new Error("Only the fork's canonical release.yml may publish.");
}
function assertPublishContext() {
  assertCi();
  if (!process.argv.includes("--execute"))
    throw new Error("Publication requires explicit --execute in the protected workflow.");
  if (
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error("GitHub-hosted OIDC with id-token: write is required.");
  if (process.env.FORK_NPM_TRUSTED_PUBLISHING_READY !== "true")
    throw new Error(
      "FORK_NPM_TRUSTED_PUBLISHING_READY must attest human setup of all six trusted publishers for release.yml, including publish and dist-tag permissions. This flag is not an authentication test.",
    );
  if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN)
    throw new Error("Use OIDC, not inherited npm publish tokens.");
}

export function prepareForkAssets(plan: ForkReleasePlan, directory: string) {
  const names = FS.readdirSync(directory);
  const desktops = requiredDesktopAssets(plan.version, names);
  for (const name of plan.cliAssets)
    if (!names.includes(name)) throw new Error(`Missing required CLI archive: ${name}`);
  for (const target of FORK_DESKTOP_MATRIX) {
    const receipt = JSON.parse(
      FS.readFileSync(Path.join(directory, `build-${target.platform}-${target.arch}.json`), "utf8"),
    ) as {
      sha: string;
      version: string;
      platform: string;
      arch: string;
      signed: boolean;
      wslSha256?: string;
    };
    if (
      receipt.sha !== plan.sha ||
      receipt.version !== plan.version ||
      receipt.platform !== target.platform ||
      receipt.arch !== target.arch ||
      receipt.signed !==
        (target.platform === "mac"
          ? plan.signing.mac
          : target.platform === "win"
            ? plan.signing.win
            : false)
    )
      throw new Error("Build receipt does not match the resolved source/version/signing matrix.");
    if (
      target.platform === "win" &&
      receipt.wslSha256 !==
        digest(Path.join(directory, cliArchiveFileName(plan.version, `linux-${target.arch}`)))
    )
      throw new Error(
        "Windows WSL runtime does not match the same-architecture Linux release archive.",
      );
  }
  if (
    plan.channel === "preview" &&
    names.some((name) => name.endsWith(".yml") || name.endsWith(".blockmap"))
  )
    throw new Error("Preview releases cannot carry automatic updater metadata.");
  if (plan.channel !== "preview") {
    const prefix = plan.channel === "stable" ? "latest" : "nightly";
    for (const [platform, primary, secondary, output] of [
      ["mac", `${prefix}-mac.yml`, `${prefix}-mac-x64.yml`, `${prefix}-mac.yml`],
      ["win", `${prefix}-win-x64.yml`, `${prefix}-win-arm64.yml`, `${prefix}.yml`],
    ]) {
      const first = Path.join(directory, primary!);
      const second = Path.join(directory, secondary!);
      const merged = mergeUpdateManifests(
        parseUpdateManifest(FS.readFileSync(first, "utf8"), primary!, platform!),
        parseUpdateManifest(FS.readFileSync(second, "utf8"), secondary!, platform!),
        platform!,
      );
      FS.writeFileSync(
        Path.join(directory, output!),
        serializeUpdateManifest(merged, { platformLabel: platform! }),
      );
      if (primary !== output) FS.unlinkSync(first);
      FS.unlinkSync(second);
    }
    for (const name of plan.feedAssets) {
      const manifest = parseUpdateManifest(
        FS.readFileSync(Path.join(directory, name), "utf8"),
        name,
        "fork",
      );
      if (manifest.version !== plan.version) throw new Error("Updater manifest version mismatch.");
      for (const file of manifest.files) {
        if (
          !desktops.includes(file.url) ||
          file.size !== FS.statSync(Path.join(directory, file.url)).size ||
          file.sha512 !== digest(Path.join(directory, file.url), "sha512", "base64")
        )
          throw new Error("Updater manifest references wrong, missing or changed release bytes.");
      }
      const required = name.includes("-mac")
        ? desktops.filter((file) => file.endsWith(".zip"))
        : name.includes("-linux")
          ? desktops.filter(
              (file) =>
                file.endsWith(".AppImage") &&
                (name.includes("arm64") ? file.includes("-arm64.") : !file.includes("-arm64.")),
            )
          : desktops.filter((file) => file.endsWith(".exe"));
      if (required.some((file) => !manifest.files.some((entry) => entry.url === file)))
        throw new Error("Updater manifest is missing an architecture.");
    }
    if (
      FS.readdirSync(directory).some(
        (name) => name.endsWith(".yml") && !plan.feedAssets.includes(name),
      )
    )
      throw new Error("Wrong-channel updater metadata was produced.");
  }
  const payloads = [
    ...desktops,
    ...plan.cliAssets,
    ...FS.readdirSync(directory).filter((name) => name.endsWith(".blockmap")),
  ];
  FS.writeFileSync(
    Path.join(directory, "SHA256SUMS"),
    payloads
      .sort()
      .map((name) => `${digest(Path.join(directory, name))}  ${name}\n`)
      .join(""),
  );
  writeJson(Path.join(directory, "release.json"), {
    ...plan,
    npmPackages: FORK_NPM_PACKAGES,
    signing: { ...plan.signing, linux: "checksum-only" },
  });
  return [...payloads, "SHA256SUMS", "release.json", ...plan.feedAssets];
}

export function inspectForkNpmPackages(directory: string, version: string) {
  const tarballs = [
    ...CLI_ARCHIVE_PLATFORM_KEYS.map((key) => Path.join(directory, "@shuv2code", `t3-${key}.tgz`)),
    Path.join(directory, "shuv2code.tgz"),
  ];
  const manifests = tarballs.map(
    (file) => JSON.parse(run("tar", ["-xOf", file, "package/package.json"])) as unknown,
  );
  const checked = assertForkNpmSet(manifests, version);
  return tarballs.map((file, index) => ({
    file,
    manifest: checked[index]!,
    integrity: `sha512-${digest(file, "sha512", "base64")}`,
  }));
}

async function registryVersion(
  pkg: { manifest: { name: string }; integrity: string },
  version: string,
) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.manifest.name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Could not verify fork npm publication.");
  const value = (await response.json()) as { dist?: { integrity?: string } };
  assertForkNpmManifest(value, version);
  if (value.dist?.integrity !== pkg.integrity)
    throw new Error(
      "Existing npm version differs from this run's immutable package bytes; recover the original prepared artifact or use a new version.",
    );
  return true;
}
async function publishPrepared(plan: ForkReleasePlan) {
  assertPublishContext();
  if (run("git", ["rev-parse", "HEAD"]) !== plan.sha)
    throw new Error("Publisher checkout differs from the resolved source.");
  const assets = "prepared/release-assets";
  const names = FS.readdirSync(assets).filter((name) => !name.startsWith("build-"));
  const packages = inspectForkNpmPackages("prepared/npm-packages", plan.version);
  const readTags = async (name: string) => {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/dist-tags`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (response.status === 404) return {} as Record<string, string>; // absence is not an ownership/readiness check
    if (!response.ok) throw new Error("Cannot verify fork dist-tag state.");
    return (await response.json()) as Record<string, string>;
  };
  const assertTagNotBackwards = async (name: string) => {
    const tags = await readTags(name);
    if (tags[plan.distTag] && compareSemverVersions(tags[plan.distTag]!, plan.version) > 0)
      throw new Error("Refusing to move a fork release/dist-tag backwards.");
  };
  for (const pkg of packages) await assertTagNotBackwards(pkg.manifest.name);
  const gh = (...args: string[]) => run("gh", args);
  const verifyTag = async (required: boolean) => {
    const response = await fetch(
      `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/commits/${plan.tag}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    // A new draft's tag may not exist until GitHub publishes the draft.
    if (response.status === 404 && !required) return;
    if (!response.ok || ((await response.json()) as { sha?: string }).sha !== plan.sha)
      throw new Error("Release tag does not resolve to the pinned source commit.");
  };
  const getRelease = () =>
    JSON.parse(gh("api", `repos/${FORK_RELEASE_REPOSITORY}/releases/tags/${plan.tag}`)) as {
      id: number;
      draft: boolean;
      target_commitish: string;
      assets: { name: string; digest?: string; size: number }[];
    };
  let release: ReturnType<typeof getRelease>;
  const verifyAssets = (expected: string[]) => {
    release = getRelease();
    if (release.target_commitish !== plan.sha)
      throw new Error("GitHub release source revision mismatch.");
    for (const name of expected) {
      const asset = release.assets.find((asset) => asset.name === name);
      if (
        !asset ||
        asset.size !== FS.statSync(Path.join(assets, name)).size ||
        asset.digest !== `sha256:${digest(Path.join(assets, name))}`
      )
        throw new Error("Required GitHub asset is missing or has a different digest.");
    }
  };
  const upload = (files: string[]) => {
    release = getRelease();
    for (const name of files) {
      const present = release.assets.find((asset) => asset.name === name);
      if (present) {
        verifyAssets([name]);
        continue;
      }
      if (!release.draft)
        throw new Error("Refusing to repair an incomplete public release automatically.");
      gh("release", "upload", plan.tag, Path.join(assets, name), "--repo", FORK_RELEASE_REPOSITORY);
    }
  };
  const verifyNpm = async () => {
    for (const pkg of packages)
      if (!(await registryVersion(pkg, plan.version)))
        throw new Error("All six exact npm versions must exist before release exposure.");
  };
  const publishPackage = async (pkg: (typeof packages)[number]) => {
    if (!(await registryVersion(pkg, plan.version)))
      await runAsync("npm", [
        "publish",
        pkg.file,
        "--access",
        "public",
        "--provenance",
        "--tag",
        plan.stagingTag,
      ]);
    // Bounded propagation retries; these run only in CI, not in tests.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await registryVersion(pkg, plan.version)) return;
      await Effect.runPromise(Effect.sleep("5 seconds"));
    }
    throw new Error("npm publication is not yet verifiable; the draft remains unavailable.");
  };
  await publishForkReleaseSequence({
    ensureDraft: async () => {
      await verifyTag(false);
      try {
        release = getRelease();
      } catch {
        gh(
          "release",
          "create",
          plan.tag,
          "--repo",
          FORK_RELEASE_REPOSITORY,
          "--target",
          plan.sha,
          "--draft",
          ...(plan.channel === "stable" ? [] : ["--prerelease"]),
          "--title",
          plan.title,
          "--notes",
          `${plan.signing.unsigned ? "UNSIGNED opt-in build: platform signatures/notarization may be absent. " : ""}Local/direct desktop and CLI release. Source: ${plan.sha}. Preview builds never enter automatic feeds.`,
        );
        release = getRelease();
      }
      if (release.target_commitish !== plan.sha)
        throw new Error("Existing release belongs to another source revision.");
    },
    uploadBinaries: async () => upload(names.filter((name) => !plan.feedAssets.includes(name))),
    verifyBinaries: async () =>
      verifyAssets(names.filter((name) => !plan.feedAssets.includes(name))),
    publishNpm: async () => {
      const results = await Promise.allSettled(
        packages.filter((pkg) => pkg.manifest.name !== "shuv2code").map(publishPackage),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error(
          "A fork platform package failed publication/verification; launcher publication was skipped. Check all six trusted publisher settings for release.yml.",
        );
      await publishPackage(packages.find((pkg) => pkg.manifest.name === "shuv2code")!);
    },
    verifyNpm,
    uploadFeeds: async () => upload(plan.feedAssets),
    verifyCompleteRelease: async () => verifyAssets(names),
    publishRelease: async () => {
      if (getRelease().draft)
        gh(
          "release",
          "edit",
          plan.tag,
          "--repo",
          FORK_RELEASE_REPOSITORY,
          "--draft=false",
          `--latest=${plan.channel === "stable"}`,
        );
      await verifyTag(true);
      if (getRelease().draft) throw new Error("GitHub release publication is not yet verifiable.");
    },
    promoteNpmTags: async () => {
      for (const pkg of packages) {
        await assertTagNotBackwards(pkg.manifest.name);
        run("npm", ["dist-tag", "add", `${pkg.manifest.name}@${plan.version}`, plan.distTag]);
        if ((await readTags(pkg.manifest.name))[plan.distTag] !== plan.version)
          throw new Error(
            "Fork dist-tag promotion is not yet verifiable; retry with the original prepared artifact.",
          );
      }
    },
    publishIndex: async () => {
      if (plan.channel === "preview") return;
      const pages = JSON.parse(
        gh(
          "api",
          "--paginate",
          "--slurp",
          `repos/${FORK_RELEASE_REPOSITORY}/releases?per_page=100`,
        ),
      ) as Parameters<typeof forkReleaseIndex>[0][];
      const index = forkReleaseIndex(pages.flat());
      if (!index.some((entry) => entry.tag_name === plan.tag))
        throw new Error("New complete release is missing from the release index.");
      writeJson("prepared/index.json", index);
      try {
        gh("release", "view", "release-index", "--repo", FORK_RELEASE_REPOSITORY);
      } catch {
        gh(
          "release",
          "create",
          "release-index",
          "--repo",
          FORK_RELEASE_REPOSITORY,
          "--target",
          plan.sha,
          "--prerelease",
          "--latest=false",
          "--title",
          "Fork release index",
          "--notes",
          "Only complete non-preview fork releases. This is not an application release.",
        );
      }
      gh(
        "release",
        "upload",
        "release-index",
        "prepared/index.json",
        "--repo",
        FORK_RELEASE_REPOSITORY,
        "--clobber",
      );
      const indexRelease = JSON.parse(
        gh("api", `repos/${FORK_RELEASE_REPOSITORY}/releases/tags/release-index`),
      ) as { assets: { name: string; digest?: string }[] };
      if (
        indexRelease.assets.find((asset) => asset.name === "index.json")?.digest !==
        `sha256:${digest("prepared/index.json")}`
      )
        throw new Error("Published release index digest mismatch.");
    },
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "preflight") {
    assertCi();
    const channel =
      process.env.GITHUB_EVENT_NAME === "push"
        ? "stable"
        : process.env.GITHUB_EVENT_NAME === "schedule"
          ? "nightly"
          : process.env.RELEASE_CHANNEL || "preview";
    const signing = releaseSigningPolicy(
      channel,
      process.env.ALLOW_UNSIGNED === "true",
      process.env,
    );
    if (process.env.FORK_NPM_TRUSTED_PUBLISHING_READY !== "true")
      throw new Error(
        "Missing FORK_NPM_TRUSTED_PUBLISHING_READY: human npm ownership/bootstrap and exact release.yml trusted-publisher setup are required; a token name or 404 is not readiness proof.",
      );
    const sha = run("git", ["rev-parse", "HEAD"]);
    const base = (
      JSON.parse(FS.readFileSync("apps/server/package.json", "utf8")) as {
        version: string;
        private?: boolean;
      }
    ).version.split("-")[0]!;
    const timestamp = process.env.RELEASE_DATE;
    if (!timestamp || Number.isNaN(Date.parse(timestamp)))
      throw new Error("Release run creation date is required for retry-stable versions.");
    const date = new Date(timestamp).toISOString().slice(0, 10).replaceAll("-", "");
    if (!/^\d+$/.test(process.env.GITHUB_RUN_NUMBER ?? ""))
      throw new Error("Release run number is required.");
    const version =
      channel === "stable"
        ? ((process.env.GITHUB_EVENT_NAME === "push"
            ? process.env.GITHUB_REF_NAME
            : process.env.RELEASE_VERSION || base
          )?.replace(/^v/, "") ?? "")
        : process.env.RELEASE_VERSION ||
          `${base}-${channel}.${date}.${process.env.GITHUB_RUN_NUMBER}`;
    const plan = forkReleasePlan({
      repository: process.env.GITHUB_REPOSITORY!,
      sha,
      version,
      channel,
      signing,
    });
    if (
      (JSON.parse(FS.readFileSync("apps/server/package.json", "utf8")) as { private?: boolean })
        .private !== true
    )
      throw new Error("Workspace t3 must remain private.");
    writeJson("release-plan.json", plan);
    FS.appendFileSync(
      process.env.GITHUB_OUTPUT!,
      `ref=${sha}\nversion=${version}\nrelease_channel=${channel}\nallow_unsigned=${process.env.ALLOW_UNSIGNED === "true"}\nmatrix=${JSON.stringify({ include: FORK_DESKTOP_MATRIX })}\n`,
    );
  } else if (mode === "signing") {
    const policy = releaseSigningPolicy(
      process.env.RELEASE_CHANNEL ?? "",
      process.env.ALLOW_UNSIGNED === "true",
      process.env,
    );
    FS.appendFileSync(
      process.env.GITHUB_OUTPUT!,
      `mac_signed=${policy.mac}\nwin_signed=${policy.win}\n`,
    );
  } else if (mode === "receipt") {
    const platform = process.env.BUILD_PLATFORM!;
    const arch = process.env.BUILD_ARCH!;
    const receipt = {
      sha: run("git", ["rev-parse", "HEAD"]),
      version: process.env.RELEASE_VERSION!,
      platform,
      arch,
      signed:
        platform === "mac"
          ? process.env.MAC_SIGNED === "true"
          : platform === "win"
            ? process.env.WIN_SIGNED === "true"
            : false,
      ...(platform === "win"
        ? {
            wslSha256: digest(
              `wsl-runtime/${cliArchiveFileName(process.env.RELEASE_VERSION!, `linux-${arch}` as "linux-arm64" | "linux-x64")}`,
            ),
          }
        : {}),
    };
    if (platform === "win") {
      const unpacked = FS.readdirSync("release").filter((name) => /^win.*-unpacked$/.test(name));
      if (
        unpacked.length !== 1 ||
        digest(Path.join("release", unpacked[0]!, "resources/wsl-runtime.tar.gz")) !==
          receipt.wslSha256
      )
        throw new Error("Packaged Windows WSL runtime is missing or mismatched.");
    }
    writeJson(`release-publish/build-${platform}-${arch}.json`, receipt);
  } else if (mode === "prepare") {
    const plan = readPlan();
    prepareForkAssets(plan, "prepared/release-assets");
    inspectForkNpmPackages("prepared/npm-packages", plan.version);
    writeJson("prepared/release-plan.json", plan);
  } else if (mode === "publish") await publishPrepared(readPlan("prepared/release-plan.json"));
  else throw new Error("Use preflight, signing, receipt, prepare or publish --execute.");
}
if (process.argv[1] && import.meta.url === URL.pathToFileURL(Path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      error instanceof Error && !/Command failed|fetch failed/.test(error.message)
        ? error.message
        : "Fork release operation failed; verify credentials, trusted-publisher allowed actions and the immutable prepared artifacts. Nothing should be inferred from a dry run.",
    );
    process.exitCode = 1;
  });
