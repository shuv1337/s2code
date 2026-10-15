// @effect-diagnostics nodeBuiltinImport:off -- Offline artifact fixtures validate real manifest and checksum preparation, never publication.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { prepareForkAssets, inspectForkNpmPackages } from "./fork-release.ts";
import {
  npmPlatformPackageManifest,
  npmLauncherPackageManifest,
} from "./build-npm-platform-packages.ts";
import { forkReleasePlan, FORK_DESKTOP_MATRIX, desktopAssetGroups } from "./lib/fork-release.ts";
import { cliArchiveFileName, CLI_ARCHIVE_PLATFORM_KEYS } from "@t3tools/shared/cliRelease";
import { serializeUpdateManifest, parseUpdateManifest } from "./lib/update-manifest.ts";
const FS = NodeFS;
const OS = NodeOS;
const Path = NodePath;
const Crypto = NodeCrypto;

function fixture(
  channel: "stable" | "nightly" | "preview",
  run: (directory: string, plan: ReturnType<typeof forkReleasePlan>) => void,
) {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "fork-release-fixture-"));
  const version = channel === "stable" ? "1.2.3" : `1.2.3-${channel}.20261014.1`;
  const plan = forkReleasePlan({
    repository: "shuv1337/shuv2code",
    sha: "ab".repeat(20),
    version,
    channel,
    signing: { mac: true, win: true, unsigned: false },
  });
  const desktops = desktopAssetGroups(version).map((group) => group[0]!);
  const sha256 = (name: string) =>
    Crypto.createHash("sha256")
      .update(FS.readFileSync(Path.join(directory, name)))
      .digest("hex");
  const manifest = (names: string[]) =>
    serializeUpdateManifest(
      {
        version,
        releaseDate: "2026-10-14T12:00:00Z",
        extras: {},
        files: names.map((url) => ({
          url,
          size: FS.statSync(Path.join(directory, url)).size,
          sha512: Crypto.createHash("sha512")
            .update(FS.readFileSync(Path.join(directory, url)))
            .digest("base64"),
        })),
      },
      { platformLabel: "fixture" },
    );
  try {
    for (const name of [...desktops, ...plan.cliAssets])
      FS.writeFileSync(Path.join(directory, name), `fixture bytes ${name}`);
    for (const target of FORK_DESKTOP_MATRIX)
      FS.writeFileSync(
        Path.join(directory, `build-${target.platform}-${target.arch}.json`),
        JSON.stringify({
          version,
          sha: plan.sha,
          platform: target.platform,
          arch: target.arch,
          signed: target.platform !== "linux",
          ...(target.platform === "win"
            ? { wslSha256: sha256(cliArchiveFileName(version, `linux-${target.arch}`)) }
            : {}),
        }),
      );
    if (channel !== "preview") {
      const prefix = channel === "stable" ? "latest" : "nightly";
      for (const [name, files] of [
        [
          `${prefix}-mac.yml`,
          desktops.filter((name) => name.endsWith(".zip") && name.includes("-arm64.")),
        ],
        [
          `${prefix}-mac-x64.yml`,
          desktops.filter((name) => name.endsWith(".zip") && name.includes("-x64.")),
        ],
        [
          `${prefix}-win-x64.yml`,
          desktops.filter((name) => name.endsWith(".exe") && name.includes("-x64.")),
        ],
        [
          `${prefix}-win-arm64.yml`,
          desktops.filter((name) => name.endsWith(".exe") && name.includes("-arm64.")),
        ],
        [
          `${prefix}-linux.yml`,
          desktops.filter((name) => /\.(deb|AppImage)$/.test(name) && !name.includes("-arm64.")),
        ],
        [
          `${prefix}-linux-arm64.yml`,
          desktops.filter((name) => /\.(deb|AppImage)$/.test(name) && name.includes("-arm64.")),
        ],
      ] as const)
        FS.writeFileSync(Path.join(directory, name), manifest([...files]));
    }
    run(directory, plan);
  } finally {
    FS.rmSync(directory, { recursive: true, force: true });
  }
}
describe("complete fork release assets", () => {
  it("checks the real public tarball manifests and byte integrity, not neighboring package directories", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-npm-fixture-"));
    try {
      const manifests = [
        ...CLI_ARCHIVE_PLATFORM_KEYS.map((key) => npmPlatformPackageManifest(key, "1.2.3", {})),
        npmLauncherPackageManifest("1.2.3", CLI_ARCHIVE_PLATFORM_KEYS),
      ];
      const packageDirectory = NodePath.join(directory, "package");
      NodeFS.mkdirSync(packageDirectory);
      const pack = (name: string, manifest: unknown) => {
        const file = NodePath.join(directory, `${name}.tgz`);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(packageDirectory, "package.json"),
          JSON.stringify(manifest),
        );
        NodeChildProcess.execFileSync("tar", ["-czf", file, "-C", directory, "package"]);
      };
      for (const manifest of manifests) pack(manifest.name, manifest);
      const checked = inspectForkNpmPackages(directory, "1.2.3");
      expect(checked.map((pkg) => pkg.manifest.name)).toEqual(
        manifests.map((manifest) => manifest.name),
      );
      for (const pkg of checked)
        expect(pkg.integrity).toBe(
          `sha512-${NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(pkg.file)).digest("base64")}`,
        );
      pack(manifests[0]!.name, { ...manifests[0], name: "t3" });
      expect(() => inspectForkNpmPackages(directory, "1.2.3")).toThrow("allowlist");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["stable", "nightly", "preview"] as const)(
    "prepares the complete %s platform matrix and final checksums",
    (channel) =>
      fixture(channel, (directory, plan) => {
        const assets = prepareForkAssets(plan, directory);
        expect(
          assets.filter((name) => /\.(dmg|zip|AppImage|deb|exe|tar\.gz)$/.test(name)),
        ).toHaveLength(15);
        const checksums = FS.readFileSync(Path.join(directory, "SHA256SUMS"), "utf8");
        for (const name of plan.cliAssets) expect(checksums).toContain(`  ${name}\n`);
        for (const name of plan.feedAssets) {
          const feed = parseUpdateManifest(
            FS.readFileSync(Path.join(directory, name), "utf8"),
            name,
            "fixture",
          );
          expect(feed.version).toBe(plan.version);
          if (name.includes("mac") || !name.includes("linux")) expect(feed.files).toHaveLength(2);
        }
        if (channel === "preview") expect(assets.some((name) => name.endsWith(".yml"))).toBe(false);
      }),
  );
  it("rejects missing CLI platforms before publishing", () =>
    fixture("stable", (directory, plan) => {
      FS.unlinkSync(Path.join(directory, plan.cliAssets[0]!));
      expect(() => prepareForkAssets(plan, directory)).toThrow("Missing required CLI");
    }));
  it("rejects mixed revisions and mismatched Windows WSL runtimes", () =>
    fixture("stable", (directory, plan) => {
      const file = Path.join(directory, "build-win-arm64.json");
      const receipt = JSON.parse(FS.readFileSync(file, "utf8"));
      FS.writeFileSync(file, JSON.stringify({ ...receipt, sha: "cd".repeat(20) }));
      expect(() => prepareForkAssets(plan, directory)).toThrow("source/version/signing");
      FS.writeFileSync(file, JSON.stringify({ ...receipt, wslSha256: "wrong" }));
      expect(() => prepareForkAssets(plan, directory)).toThrow("WSL runtime");
    }));
  it("rejects wrong feed bytes and preview automatic metadata", () => {
    fixture("stable", (directory, plan) => {
      FS.appendFileSync(Path.join(directory, `T3-Code-${plan.version}-arm64.zip`), "changed");
      expect(() => prepareForkAssets(plan, directory)).toThrow("changed release bytes");
    });
    fixture("preview", (directory, plan) => {
      FS.writeFileSync(Path.join(directory, "latest.yml"), "foreign updater");
      expect(() => prepareForkAssets(plan, directory)).toThrow("Preview releases");
    });
  });
});
