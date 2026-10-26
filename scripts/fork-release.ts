// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off -- Guarded release CLI boundary; publishing is reachable only with explicit CI execution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { CLI_ARCHIVE_PLATFORM_KEYS, cliArchiveFileName } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { NPM_PACKAGE_NAME } from "@t3tools/shared/productIdentity";
import {
  FORK_RELEASE_REPOSITORY,
  FORK_RELEASE_INDEX_BRANCH,
  publishAtomicReleaseIndex,
  FORK_DESKTOP_MATRIX,
  FORK_NPM_PACKAGES,
  forkNpmPublishingReady,
  MAC_RELEASE_CREDENTIALS,
  WIN_RELEASE_CREDENTIALS,
  RELEASE_CREDENTIAL_VARIABLES,
  releaseSigningPolicy,
  forkReleasePlan,
  forkReleaseBody,
  forkReleaseTitle,
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
const { isAllowedForkPublishRef } = NodeModule.createRequire(import.meta.url)(
  "../.github/scripts/check-nightly-release.cjs",
) as {
  isAllowedForkPublishRef: (ref: string | undefined, defaultBranch: string | undefined) => boolean;
};

export function releaseCommandError(
  command: string,
  args: string[],
  cause: unknown,
  stderr?: string,
) {
  const failure = cause as { status?: unknown; code?: unknown; stderr?: unknown };
  const text =
    stderr ??
    (typeof failure?.stderr === "string"
      ? failure.stderr
      : Buffer.isBuffer(failure?.stderr)
        ? failure.stderr.toString("utf8")
        : "");
  const http = /\b(?:HTTP[\s/:]*|E)(\d{3})\b/i.exec(text)?.[1];
  const exit = failure?.status ?? failure?.code ?? "unknown";
  return new Error(
    `${command} ${args.map((arg) => JSON.stringify(arg)).join(" ")} failed (exit ${String(exit)}${http ? `; HTTP ${http}` : ""}).`,
  );
}
const run = (command: string, args: string[], cwd?: string) => {
  try {
    return CP.execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw releaseCommandError(command, args, error);
  }
};
const runAsync = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    CP.execFile(command, args, { encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error) reject(releaseCommandError(command, args, error, stderr));
      else resolve();
    });
  });
const releaseFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error(`${init?.method ?? "GET"} ${String(input)} failed (network error).`);
  }
};
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
  if (!isAllowedForkPublishRef(process.env.GITHUB_REF, process.env.GITHUB_DEFAULT_BRANCH))
    throw new Error("Publication requires the default branch.");
}
function assertPublishContext(npm: boolean) {
  assertCi();
  if (!process.argv.includes("--execute"))
    throw new Error("Publication requires explicit --execute in the protected workflow.");
  if (!npm) return;
  if (
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  )
    throw new Error("GitHub-hosted OIDC with id-token: write is required.");
  if (!forkNpmPublishingReady(process.env))
    throw new Error(
      "S2CODE_NPM_TRUSTED_PUBLISHING_READY must attest the six new publishers and FORK_NPM_TRUSTED_PUBLISHING_READY the shuv2code bridge, including publish and dist-tag permissions for release.yml. These flags are not authentication tests.",
    );
  if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN)
    throw new Error("Use OIDC, not inherited npm publish tokens.");
}

export function prepareForkAssets(plan: ForkReleasePlan, directory: string) {
  const names = FS.readdirSync(directory);
  const desktops = requiredDesktopAssets(plan.version, names);
  for (const name of plan.cliAssets)
    if (!names.includes(name)) throw new Error(`Missing required CLI archive: ${name}`);
  // Keep aliases for installs from before the archive rename; remove after that transition ends.
  for (let index = 0; index < plan.cliAssets.length; index++) {
    for (const aliases of [plan.cliPreviousAssets, plan.cliLegacyAssets])
      FS.copyFileSync(
        Path.join(directory, plan.cliAssets[index]!),
        Path.join(directory, aliases[index]!),
      );
  }
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
      // An unsigned platform has no feed in the plan: electron-builder still
      // wrote per-arch manifests, so drop them instead of merging.
      if (plan.feedAssets.includes(output!)) {
        const merged = mergeUpdateManifests(
          parseUpdateManifest(FS.readFileSync(first, "utf8"), primary!, platform!),
          parseUpdateManifest(FS.readFileSync(second, "utf8"), secondary!, platform!),
          platform!,
        );
        FS.writeFileSync(
          Path.join(directory, output!),
          serializeUpdateManifest(merged, { platformLabel: platform! }),
        );
      }
      if (primary !== output || !plan.feedAssets.includes(output!)) FS.unlinkSync(first);
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
    // Blockmaps only serve differential updates, so a platform without a feed
    // has no use for them. Their extension identifies the platform.
    const strandedBlocks = [
      ...(plan.signing.mac ? [] : [".dmg.blockmap", ".zip.blockmap"]),
      ...(plan.signing.win ? [] : [".exe.blockmap"]),
    ];
    for (const name of FS.readdirSync(directory))
      if (strandedBlocks.some((suffix) => name.endsWith(suffix)))
        FS.unlinkSync(Path.join(directory, name));
  }
  const payloads = [
    ...desktops,
    ...plan.cliAssets,
    ...plan.cliLegacyAssets,
    ...plan.cliPreviousAssets,
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
    npmPackages: plan.npm ? FORK_NPM_PACKAGES : [],
    signing: { ...plan.signing, linux: "checksum-only" },
  });
  return [...payloads, "SHA256SUMS", "release.json", ...plan.feedAssets];
}

/**
 * The name electron-builder's NSIS installer embeds its app payload under. The
 * build directory calls the archive `<name>-<version>-<arch>.nsis.7z`, but
 * `File /oname=` renames it on the way in; see app-builder-lib's
 * templates/nsis/include/extractAppPackage.nsh.
 */
export function windowsInstallerPayloadName(arch: string) {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Unsupported Windows release architecture: ${arch}.`);
  return `app-${arch === "x64" ? "64" : "arm64"}.7z`;
}
const SEVEN_ZIP_COMMANDS = ["7z", "C:\\Program Files\\7-Zip\\7z.exe"];
/**
 * Extract one entry, by pattern, from an archive 7-Zip can open.
 *
 * 7-Zip exits 1 for warnings it recovered from, so only exit 2 and above is a
 * failure; whether the wanted file is on disk decides the rest.
 */
function extractArchiveEntry(archive: string, entry: string, into: string) {
  const args = ["x", "-y", "-r", `-o${into}`, archive, entry];
  for (const command of SEVEN_ZIP_COMMANDS) {
    try {
      CP.execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      return;
    } catch (error) {
      const failure = error as { code?: unknown; status?: unknown };
      if (failure.code === "ENOENT") continue;
      if (typeof failure.status === "number" && failure.status < 2) return;
      throw releaseCommandError(command, args, error);
    }
  }
  throw new Error(
    `Reading the Windows installer payload needs 7-Zip; none of ${SEVEN_ZIP_COMMANDS.join(", ")} ran.`,
  );
}
/**
 * Read the app payload back out of the installer users will run. `release/`
 * keeps only finished artifacts, so there is no unpacked build tree left to
 * inspect by the time the receipt is written.
 */
export function extractPackagedWslRuntime(installerDir: string, arch: string, workDir: string) {
  const expected = windowsInstallerPayloadName(arch);
  const installers = FS.readdirSync(installerDir).filter((name) => name.endsWith(".exe"));
  if (installers.length !== 1)
    throw new Error(
      `Expected exactly one Windows installer in ${installerDir}; found ${installers.length}.`,
    );
  FS.rmSync(workDir, { recursive: true, force: true });
  const inner = Path.join(workDir, "inner");
  extractArchiveEntry(Path.join(installerDir, installers[0]!), "app-*.7z", inner);
  const payloads = (FS.existsSync(inner) ? FS.readdirSync(inner, { recursive: true }) : [])
    .map(String)
    .filter((name) => name.endsWith(".7z"));
  if (payloads.length !== 1 || Path.basename(payloads[0]!) !== expected)
    throw new Error(
      `Expected ${expected} inside ${installers[0]}; found ${payloads.join(", ") || "no app payload"}.`,
    );
  const payload = Path.join(workDir, "app");
  extractArchiveEntry(Path.join(inner, payloads[0]!), "resources/wsl-runtime.tar.gz", payload);
  return payload;
}
export function assertPackagedWslRuntime(payloadDir: string, expected: string) {
  const file = Path.join(payloadDir, "resources", "wsl-runtime.tar.gz");
  if (!FS.existsSync(file))
    throw new Error(`The Windows installer payload has no resources/wsl-runtime.tar.gz (${file}).`);
  const actual = digest(file);
  if (actual !== expected)
    throw new Error(
      `Packaged Windows WSL runtime ${actual} does not match the released Linux archive ${expected}.`,
    );
}

export function inspectForkNpmPackages(directory: string, version: string) {
  const tarballs = [
    ...CLI_ARCHIVE_PLATFORM_KEYS.map((key) => Path.join(directory, "@s2code", `t3-${key}.tgz`)),
    Path.join(directory, "@s2code", "cli.tgz"),
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

// Only tests shorten the wait; CI keeps the real cadence.
const configuredPollMs = Number(process.env.FORK_RELEASE_NPM_POLL_MS);
const NPM_POLL_MS =
  Number.isFinite(configuredPollMs) && configuredPollMs > 0 ? configuredPollMs : 15_000;
/**
 * Attempts cover the budget at the normal fifteen-second cadence, so a shorter
 * interval makes the same number of polls finish sooner rather than multiplying
 * them.
 */
const pollsWithin = (budgetMs: number) => Math.max(1, Math.ceil(budgetMs / 15_000));
/** npm holds each new version in review before it is installable: ~15 minutes. */
const NPM_REVIEW_POLLS = pollsWithin(30 * 60_000);
/** Registry propagation for a dist-tag write, or one answer that did not arrive. */
const NPM_TAG_POLLS = pollsWithin(60_000);

/** Release-list reads before concluding a tag has no release; about fifteen seconds. */
const RELEASE_LIST_POLLS = 4;
const RELEASE_LIST_POLL_MS = Math.min(5_000, NPM_POLL_MS);
/** A registry answer that says nothing about the package, so it can be retried. */
class TransientRegistryError extends Error {}
/** GET a registry endpoint, separating "no answer" from a real verdict. */
async function registryFetch(url: string) {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new TransientRegistryError(`GET ${url} failed (network error or timeout).`);
  }
  if (response.status === 429 || response.status >= 500)
    throw new TransientRegistryError(`GET ${url} failed (HTTP ${response.status}).`);
  return response;
}
/**
 * Poll the registry until `read` answers. `undefined` means "not yet", and a
 * transient failure counts as "not yet" except that exhausting the budget
 * reports it. Every other failure throws at once, so an integrity or allowlist
 * violation still fails the release immediately.
 */
async function pollRegistry<T>(input: {
  readonly attempts: number;
  readonly read: () => Promise<T | undefined>;
  readonly exhausted: string;
  readonly waiting?: string;
}): Promise<T> {
  let transient: string | undefined;
  for (let attempt = 1; attempt <= input.attempts; attempt++) {
    try {
      const answer = await input.read();
      if (answer !== undefined) return answer;
      transient = undefined;
    } catch (error) {
      if (!(error instanceof TransientRegistryError)) throw error;
      transient = error.message;
    }
    if (attempt === input.attempts) break;
    if (input.waiting && attempt % 4 === 0) console.log(input.waiting);
    await Effect.runPromise(Effect.sleep(Duration.millis(NPM_POLL_MS)));
  }
  throw new Error(
    transient ? `${input.exhausted} Last registry failure: ${transient}` : input.exhausted,
  );
}
async function registryVersion(
  pkg: { manifest: { name: string }; integrity: string },
  version: string,
) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.manifest.name)}/${encodeURIComponent(version)}`;
  const response = await registryFetch(url);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GET ${url} failed (HTTP ${response.status}).`);
  const value = (await response.json()) as { dist?: { integrity?: string } };
  assertForkNpmManifest(value, version);
  if (value.dist?.integrity !== pkg.integrity)
    throw new Error(
      "Existing npm version differs from this run's immutable package bytes; recover the original prepared artifact or use a new version.",
    );
  return true;
}
async function publishPrepared(plan: ForkReleasePlan) {
  assertPublishContext(plan.npm);
  if (run("git", ["rev-parse", "HEAD"]) !== plan.sha)
    throw new Error("Publisher checkout differs from the resolved source.");
  const assets = "prepared/release-assets";
  const names = FS.readdirSync(assets).filter((name) => !name.startsWith("build-"));
  const packages = inspectForkNpmPackages("prepared/npm-packages", plan.version);
  const readTags = async (name: string) => {
    // `/<name>/dist-tags` would be read as a version named "dist-tags".
    const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`;
    const answer = await pollRegistry({
      attempts: NPM_TAG_POLLS,
      read: async () => {
        const response = await registryFetch(url);
        // A name nobody has published answers 404 unscoped and 401 scoped on
        // this unauthenticated public GET. Neither is an ownership or
        // readiness check.
        if (response.status === 404 || response.status === 401)
          return { tags: {} as Record<string, string> };
        if (!response.ok) throw new Error(`GET ${url} failed (HTTP ${response.status}).`);
        return { tags: (await response.json()) as Record<string, string> };
      },
      exhausted: `The npm registry did not answer dist-tags for ${name}.`,
    });
    return answer.tags;
  };
  const assertTagNotBackwards = async (name: string) => {
    const tags = await readTags(name);
    if (tags[plan.distTag] && compareSemverVersions(tags[plan.distTag]!, plan.version) > 0)
      throw new Error("Refusing to move a fork release/dist-tag backwards.");
  };
  if (plan.npm) for (const pkg of packages) await assertTagNotBackwards(pkg.manifest.name);
  const gh = (...args: string[]) => run("gh", args);
  const verifyTag = async (required: boolean) => {
    const response = await releaseFetch(
      `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/commits/${plan.tag}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    // A new draft's tag may not exist until GitHub publishes the draft. The
    // commits API answers an unknown ref with 422 "No commit found for SHA";
    // any other 422 is a validation failure and stays an error.
    if (!required) {
      if (response.status === 404) return;
      if (response.status === 422) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as { message?: unknown } | null;
        if (typeof body?.message === "string" && body.message.startsWith("No commit found for SHA"))
          return;
      }
    }
    if (!response.ok)
      throw new Error(
        `GET https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/commits/${plan.tag} failed (HTTP ${response.status}).`,
      );
    if (((await response.json()) as { sha?: string }).sha !== plan.sha)
      throw new Error("Release tag does not resolve to the pinned source commit.");
  };
  type Release = {
    id: number;
    tag_name: string;
    draft: boolean;
    target_commitish: string;
    assets: { name: string; digest?: string; size: number }[];
  };
  let releaseId: number | undefined;
  const findRelease = () => {
    const found =
      releaseId === undefined
        ? (
            JSON.parse(
              gh(
                "api",
                "--paginate",
                "--slurp",
                `repos/${FORK_RELEASE_REPOSITORY}/releases?per_page=100`,
              ),
            ) as Release[][]
          )
            .flat()
            .find((entry) => entry.tag_name === plan.tag)
        : (JSON.parse(
            gh("api", `repos/${FORK_RELEASE_REPOSITORY}/releases/${releaseId}`),
          ) as Release);
    if (found && found.tag_name !== plan.tag) throw new Error("GitHub release tag mismatch.");
    if (found) releaseId = found.id;
    return found;
  };
  // The release list lags drafts created moments ago, so look a few times
  // before concluding that this tag has no release yet.
  const settleRelease = async () => {
    for (let attempt = 1; ; attempt++) {
      const found = findRelease();
      if (found || attempt >= RELEASE_LIST_POLLS) return found;
      await Effect.runPromise(Effect.sleep(Duration.millis(RELEASE_LIST_POLL_MS)));
    }
  };
  const getRelease = () => {
    const found = findRelease();
    if (!found) throw new Error("Expected fork release is missing, including drafts.");
    return found;
  };
  let release: Release;
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
      gh(
        "api",
        "-X",
        "POST",
        `https://uploads.github.com/repos/${FORK_RELEASE_REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        "-H",
        "Content-Type: application/octet-stream",
        "--input",
        Path.join(assets, name),
      );
    }
  };
  // Every registry read goes through pollRegistry, so a registry that did not
  // answer is never mistaken for a verdict about the package.
  const publishedVersion = (pkg: (typeof packages)[number]) =>
    pollRegistry({
      attempts: NPM_TAG_POLLS,
      read: async () => ({ published: await registryVersion(pkg, plan.version) }),
      exhausted: `The npm registry did not answer for ${pkg.manifest.name}@${plan.version}.`,
    });
  const verifyNpm = async () => {
    if (!plan.npm) return;
    for (const pkg of packages)
      if (!(await publishedVersion(pkg)).published)
        throw new Error("All seven exact npm versions must exist before release exposure.");
  };
  const publishPackage = async (pkg: (typeof packages)[number]) => {
    // A transient answer must never read as "absent" here: publishing over an
    // existing immutable version is refused by npm, not retried.
    if (!(await publishedVersion(pkg)).published)
      await runAsync("npm", [
        "publish",
        pkg.file,
        "--access",
        "public",
        "--provenance",
        "--tag",
        plan.stagingTag,
      ]);
    // npm reviews each new version before it becomes installable, which took
    // up to about fifteen minutes for these packages. Wait well past that.
    await pollRegistry({
      attempts: NPM_REVIEW_POLLS,
      read: async () => (await registryVersion(pkg, plan.version)) || undefined,
      exhausted: "npm publication is not yet verifiable; the draft remains unavailable.",
      waiting: `Waiting for npm to finish reviewing ${pkg.manifest.name}@${plan.version}.`,
    });
  };
  await publishForkReleaseSequence({
    ensureDraft: async () => {
      await verifyTag(false);
      let existing = await settleRelease();
      if (!existing) {
        // Keep the id the API returns and read the release by id from here on.
        let created: Release | undefined;
        try {
          created = JSON.parse(
            gh(
              "api",
              "-X",
              "POST",
              `repos/${FORK_RELEASE_REPOSITORY}/releases`,
              "-f",
              `tag_name=${plan.tag}`,
              "-f",
              `target_commitish=${plan.sha}`,
              "-F",
              "draft=true",
              "-F",
              `prerelease=${plan.channel !== "stable"}`,
              "-f",
              `name=${forkReleaseTitle(plan)}`,
              "-f",
              `body=${forkReleaseBody(plan)}`,
            ),
          ) as Release;
        } catch (error) {
          // A draft this list had not caught up with yet: reuse it, never add a second.
          existing = await settleRelease();
          if (!existing) throw error;
        }
        if (created) {
          if (created.tag_name !== plan.tag || typeof created.id !== "number")
            throw new Error("GitHub did not return the created release.");
          releaseId = created.id;
        }
      }
      release = existing ?? getRelease();
      if (release.target_commitish !== plan.sha)
        throw new Error("Existing release belongs to another source revision.");
    },
    uploadBinaries: async () => upload(names.filter((name) => !plan.feedAssets.includes(name))),
    verifyBinaries: async () =>
      verifyAssets(names.filter((name) => !plan.feedAssets.includes(name))),
    publishNpm: async () => {
      if (!plan.npm) return;
      const results = await Promise.allSettled(
        packages.filter((pkg) => pkg.manifest.name.startsWith("@s2code/t3-")).map(publishPackage),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new Error(
          `A fork platform package failed publication/verification; launcher publication was skipped. ${failures.map((result) => (result.reason instanceof Error ? result.reason.message : "Unknown publication failure.")).join(" ")}`,
        );
      await publishPackage(packages.find((pkg) => pkg.manifest.name === NPM_PACKAGE_NAME)!);
      await publishPackage(packages.find((pkg) => pkg.manifest.name === "shuv2code")!);
    },
    verifyNpm,
    uploadFeeds: async () => upload(plan.feedAssets),
    verifyCompleteRelease: async () => verifyAssets(names),
    publishRelease: async () => {
      if (getRelease().draft)
        gh(
          "api",
          "-X",
          "PATCH",
          `repos/${FORK_RELEASE_REPOSITORY}/releases/${releaseId}`,
          "-F",
          "draft=false",
          "-f",
          `make_latest=${plan.channel === "stable"}`,
        );
      await verifyTag(true);
      if (getRelease().draft) throw new Error("GitHub release publication is not yet verifiable.");
    },
    promoteNpmTags: async () => {
      if (!plan.npm) return;
      for (const pkg of packages) {
        await assertTagNotBackwards(pkg.manifest.name);
        const tags = await readTags(pkg.manifest.name);
        for (const tag of plan.distTags) {
          // The channel tag refuses to move backwards above; an alias such as
          // nightly's `latest` yields to a newer published version instead of
          // failing a release that is otherwise complete.
          if (
            tag !== plan.distTag &&
            tags[tag] &&
            compareSemverVersions(tags[tag]!, plan.version) > 0
          ) {
            console.log(
              `Leaving ${pkg.manifest.name}@${tag} on ${tags[tag]}; it is newer than ${plan.version}.`,
            );
            continue;
          }
          run("npm", ["dist-tag", "add", `${pkg.manifest.name}@${plan.version}`, tag]);
          await pollRegistry({
            attempts: NPM_TAG_POLLS,
            read: async () =>
              (await readTags(pkg.manifest.name))[tag] === plan.version ? true : undefined,
            exhausted:
              "Fork dist-tag promotion is not yet verifiable; retry with the original prepared artifact.",
          });
        }
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
      const releases = pages.flat();
      // The list can still lag this release; read it by id rather than drop it.
      if (!releases.some((entry) => entry.tag_name === plan.tag)) releases.push(getRelease());
      const index = forkReleaseIndex(releases);
      // A release without a macOS or Windows feed is deliberately incomplete,
      // so the index keeps the previous entries instead of gaining this one.
      if (
        plan.signing.mac &&
        plan.signing.win &&
        !index.some((entry) => entry.tag_name === plan.tag)
      )
        throw new Error("New complete release is missing from the release index.");
      writeJson("prepared/index.json", index);
      const get = (path: string) =>
        releaseFetch(`https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/${path}`, {
          headers: {
            Authorization: `Bearer ${process.env.GH_TOKEN}`,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(30_000),
        });
      const branch = await get(`git/ref/heads/${FORK_RELEASE_INDEX_BRANCH}`);
      if (branch.status === 404)
        gh(
          "api",
          "-X",
          "POST",
          `repos/${FORK_RELEASE_REPOSITORY}/git/refs`,
          "-f",
          `ref=refs/heads/${FORK_RELEASE_INDEX_BRANCH}`,
          "-f",
          `sha=${plan.sha}`,
        );
      else if (!branch.ok)
        throw new Error(
          `GET https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/git/ref/heads/${FORK_RELEASE_INDEX_BRANCH} failed (HTTP ${branch.status}).`,
        );
      // GitHub Contents creates a commit and atomically advances the branch ref.
      // A failed write/CAS leaves the old file and its public raw URL untouched.
      await publishAtomicReleaseIndex(FS.readFileSync("prepared/index.json", "utf8"), {
        read: async () => {
          const response = await get(`contents/index.json?ref=${FORK_RELEASE_INDEX_BRANCH}`);
          if (response.status === 404) return null;
          if (!response.ok)
            throw new Error(
              `GET https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/contents/index.json failed (HTTP ${response.status}).`,
            );
          const file = (await response.json()) as {
            sha: string;
            encoding: string;
            content: string;
          };
          if (
            file.encoding !== "base64" ||
            typeof file.sha !== "string" ||
            typeof file.content !== "string"
          )
            throw new Error("Invalid release index storage response.");
          return { sha: file.sha, content: Buffer.from(file.content, "base64").toString("utf8") };
        },
        write: async (content, sha) => {
          writeJson("prepared/index-publication.json", {
            message: `chore(release): index ${plan.tag}`,
            branch: FORK_RELEASE_INDEX_BRANCH,
            content: Buffer.from(content).toString("base64"),
            ...(sha ? { sha } : {}),
          });
          gh(
            "api",
            "-X",
            "PUT",
            `repos/${FORK_RELEASE_REPOSITORY}/contents/index.json`,
            "--input",
            "prepared/index-publication.json",
          );
        },
      });
    },
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "preflight") {
    assertCi();
    // The workflow states the channel for every event; nothing is inferred
    // from the trigger.
    const channel = process.env.RELEASE_CHANNEL || "preview";
    const signing = releaseSigningPolicy(
      channel,
      process.env.ALLOW_UNSIGNED === "true",
      process.env,
    );
    const npm = forkNpmPublishingReady(process.env);
    if (!npm)
      console.log(
        "npm publication skipped: both S2CODE_NPM_TRUSTED_PUBLISHING_READY and the legacy bridge readiness are required. Only the GitHub release will publish.",
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
      npm,
    });
    if (
      (JSON.parse(FS.readFileSync("apps/server/package.json", "utf8")) as { private?: boolean })
        .private !== true
    )
      throw new Error("Workspace t3 must remain private.");
    writeJson("release-plan.json", plan);
    // The build jobs run outside this environment, so they get the team id
    // resolved here instead of looking it up in a narrower variable scope.
    const team = process.env.APPLE_TEAM_ID?.trim() ?? "";
    FS.appendFileSync(
      process.env.GITHUB_OUTPUT!,
      `ref=${sha}\nversion=${version}\nrelease_channel=${channel}\nmac_signed=${signing.mac}\nwin_signed=${signing.win}\napple_team_id=${/^[A-Za-z0-9]+$/.test(team) ? team : ""}\nmatrix=${JSON.stringify({ include: FORK_DESKTOP_MATRIX })}\n`,
    );
  } else if (mode === "signing") {
    // Preflight resolved signing once, inside the release environment. A build
    // job only confirms that the credentials its planned-signed platform needs
    // reached this runner, and fails closed when they did not.
    const planned = {
      mac: process.env.MAC_SIGNED === "true",
      win: process.env.WIN_SIGNED === "true",
    };
    const platform = process.env.BUILD_PLATFORM;
    const required =
      platform === "mac"
        ? MAC_RELEASE_CREDENTIALS
        : platform === "win"
          ? WIN_RELEASE_CREDENTIALS
          : [];
    const missing = required.filter((key) => !process.env[key]?.trim());
    if (
      (platform === "mac" ? planned.mac : platform === "win" ? planned.win : false) &&
      missing.length
    )
      throw new Error(
        `The release plans a signed ${platform} build, but this job cannot see ${missing
          .map((key) =>
            RELEASE_CREDENTIAL_VARIABLES.includes(key) ? `${key} (variable)` : `${key} (secret)`,
          )
          .join(
            ", ",
          )}. Signing inputs must be repository or organization secrets and variables; anything scoped to the fork-release environment is invisible here.`,
      );
    FS.appendFileSync(
      process.env.GITHUB_OUTPUT!,
      `mac_signed=${planned.mac}\nwin_signed=${planned.win}\n`,
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
    if (platform === "win")
      assertPackagedWslRuntime(
        extractPackagedWslRuntime(
          "release-publish",
          arch,
          Path.join(process.env.RUNNER_TEMP ?? process.cwd(), `installer-payload-${arch}`),
        ),
        receipt.wslSha256!,
      );
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
      error instanceof Error && !(error instanceof SyntaxError)
        ? error.message
        : "Fork release operation failed; verify credentials, trusted-publisher allowed actions and the immutable prepared artifacts. Nothing should be inferred from a dry run.",
    );
    process.exitCode = 1;
  });
