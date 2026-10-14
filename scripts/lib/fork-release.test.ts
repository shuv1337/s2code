import { describe, expect, it } from "@effect/vitest";
import { CLI_ARCHIVE_PLATFORM_KEYS } from "@t3tools/shared/cliRelease";
import {
  FORK_DESKTOP_MATRIX,
  FORK_NPM_PACKAGES,
  MAC_RELEASE_CREDENTIALS,
  WIN_RELEASE_CREDENTIALS,
  releaseSigningPolicy,
  forkReleasePlan,
  assertForkNpmSet,
  assertForkNpmManifest,
  assertForkDistTag,
  forkReleaseIndex,
  publishForkReleaseSequence,
  desktopAssetGroups,
  publishAtomicReleaseIndex,
  FORK_RELEASE_INDEX_URL,
} from "./fork-release.ts";
import serverPackage from "../../apps/server/package.json" with { type: "json" };
const sha = "ab".repeat(20);
const fullCredentials = Object.fromEntries(
  [...MAC_RELEASE_CREDENTIALS, ...WIN_RELEASE_CREDENTIALS].map((key) => [key, "configured"]),
);
const plan = (channel = "stable", version = "1.2.3") =>
  forkReleasePlan({
    repository: "shuv1337/shuv2code",
    sha,
    version,
    channel,
    signing: releaseSigningPolicy(channel, false, fullCredentials),
  });
const manifests = (version = "1.2.3") =>
  FORK_NPM_PACKAGES.map((name) => ({
    name,
    version,
    repository: { url: "https://github.com/shuv1337/shuv2code" },
    ...(name === "shuv2code"
      ? {
          optionalDependencies: Object.fromEntries(
            FORK_NPM_PACKAGES.filter((name) => name !== "shuv2code").map((name) => [name, version]),
          ),
        }
      : {}),
  }));
describe("fork release contract", () => {
  it("keeps the last public index when atomic publication fails and uses a stable reader URL", async () => {
    const previous = { sha: "old-blob", content: '[{"tag_name":"v1.2.2","draft":false}]\n' };
    let current = previous;
    const next = '[{"tag_name":"v1.2.3","draft":false}]\n';
    let fail = true;
    const store = {
      read: async () => current,
      write: async (content: string, sha: string | undefined) => {
        expect(sha).toBe(current.sha);
        if (fail) throw new Error("injected upload failure");
        current = { sha: "new-blob", content };
      },
    };
    await expect(publishAtomicReleaseIndex(next, store)).rejects.toThrow("injected upload failure");
    expect(current).toEqual(previous);
    fail = false;
    await publishAtomicReleaseIndex(next, store);
    expect(current.content).toBe(next);
    expect(FORK_RELEASE_INDEX_URL).toBe(
      "https://raw.githubusercontent.com/shuv1337/shuv2code/fork-release-index/index.json",
    );
  });
  it("covers six native desktops and exactly five CLI architectures with matching Windows/Linux pairs", () => {
    expect(FORK_DESKTOP_MATRIX).toHaveLength(6);
    expect(FORK_DESKTOP_MATRIX.map((target) => target.runner)).toEqual([
      "macos-15",
      "macos-15-intel",
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "windows-2025",
      "windows-11-arm",
    ]);
    expect(FORK_DESKTOP_MATRIX.filter((target) => target.cli_archive)).toHaveLength(5);
    expect(CLI_ARCHIVE_PLATFORM_KEYS).not.toContain("darwin-x64");
    for (const target of FORK_DESKTOP_MATRIX.filter((target) => target.platform === "win"))
      expect(
        FORK_DESKTOP_MATRIX.some(
          (linux) => linux.platform === "linux" && linux.arch === target.arch && linux.cli_archive,
        ),
      ).toBe(true);
  });
  it("fails closed without stable credentials, regardless of unsigned opt-in", () => {
    expect(() => releaseSigningPolicy("stable", false, {})).toThrow("Missing fork signing");
    expect(() => releaseSigningPolicy("stable", true, fullCredentials)).toThrow("Stable");
    expect(() => releaseSigningPolicy("nightly", false, {})).toThrow("allow_unsigned");
  });
  it("labels explicitly opted-in unsigned nightly and preview builds, but never stable", () => {
    for (const channel of ["nightly", "preview"]) {
      const version = `1.2.3-${channel}.20261014.1`;
      const value = forkReleasePlan({
        repository: "shuv1337/shuv2code",
        sha,
        version,
        channel,
        signing: releaseSigningPolicy(channel, true, {}),
      });
      expect(value.title).toContain("UNSIGNED");
      expect(value.distTag).toBe(channel);
      expect(value.distTag).not.toBe("latest");
      if (channel === "preview") expect(value.feedAssets).toEqual([]);
    }
  });
  it("keeps stable/nightly feeds channel-bound and rejects upstream repositories and channel/version mismatches", () => {
    expect(plan().feedAssets).toEqual([
      "latest-mac.yml",
      "latest-linux.yml",
      "latest-linux-arm64.yml",
      "latest.yml",
    ]);
    expect(
      plan("nightly", "1.2.3-nightly.20261014.1").feedAssets.every((name) =>
        name.startsWith("nightly"),
      ),
    ).toBe(true);
    expect(() => forkReleasePlan({ ...plan(), repository: "pingdotgg/t3code" })).toThrow(
      "fork repository",
    );
    expect(() => plan("stable", "1.2.3-preview.20261014.1")).toThrow("channel");
  });
  it("protects the private t3 workspace and exact public allowlist", () => {
    expect(serverPackage.private).toBe(true);
    expect(assertForkNpmSet(manifests(), "1.2.3")).toHaveLength(6);
    for (const override of [
      { name: "t3" },
      { name: "@t3code/t3-linux-x64" },
      { private: true },
      { version: "1.2.4" },
      { repository: { url: "https://github.com/pingdotgg/t3code" } },
    ])
      expect(() => assertForkNpmManifest({ ...manifests()[0], ...override }, "1.2.3")).toThrow(
        "allowlist",
      );
    expect(() => assertForkNpmSet(manifests().slice(1), "1.2.3")).toThrow("All five");
    expect(() =>
      assertForkNpmManifest(
        { ...manifests().at(-1), optionalDependencies: { "@shuv2code/t3-linux-x64": "1.2.3" } },
        "1.2.3",
      ),
    ).toThrow("all five");
  });
  it("prevents preview/nightly from moving latest and permits only matching staging tags", () => {
    for (const channel of ["nightly", "preview"]) {
      const value = plan(channel, `1.2.3-${channel}.20261014.1`);
      expect(() => assertForkDistTag(value.version, "latest")).toThrow();
      expect(() => assertForkDistTag(value.version, value.distTag)).not.toThrow();
      expect(() => assertForkDistTag(value.version, value.stagingTag)).not.toThrow();
    }
  });
  it("emits #272-compatible index entries only for complete non-preview public releases", () => {
    const value = plan();
    const release = {
      tag_name: value.tag,
      draft: false,
      assets: [
        ...value.cliAssets,
        ...desktopAssetGroups(value.version).map((group) => group[0]!),
        ...value.feedAssets,
        "SHA256SUMS",
        "release.json",
      ].map((name) => ({ name })),
    };
    expect(
      forkReleaseIndex([
        release,
        { ...release, draft: true },
        { ...release, tag_name: "v1.2.3-preview.20261014.1" },
        { ...release, assets: [] },
      ]),
    ).toEqual([{ tag_name: "v1.2.3", draft: false }]);
  });
  it("exposes feeds and release/index only after binary and npm verification", async () => {
    const order: string[] = [];
    const steps = [
      "ensureDraft",
      "uploadBinaries",
      "verifyBinaries",
      "publishNpm",
      "verifyNpm",
      "uploadFeeds",
      "verifyCompleteRelease",
      "publishRelease",
      "promoteNpmTags",
      "publishIndex",
    ] as const;
    const operations = Object.fromEntries(
      steps.map((step) => [
        step,
        async () => {
          order.push(step);
        },
      ]),
    ) as Parameters<typeof publishForkReleaseSequence>[0];
    await publishForkReleaseSequence(operations);
    expect(order).toEqual(steps);
    for (const blocked of ["verifyBinaries", "publishNpm", "verifyNpm", "verifyCompleteRelease"]) {
      order.length = 0;
      await expect(
        publishForkReleaseSequence({
          ...operations,
          [blocked]: async () => {
            order.push(blocked);
            throw new Error("fixture failure");
          },
        }),
      ).rejects.toThrow("fixture failure");
      expect(order).not.toContain("publishRelease");
      expect(order).not.toContain("promoteNpmTags");
      expect(order).not.toContain("publishIndex");
    }
  });
});
