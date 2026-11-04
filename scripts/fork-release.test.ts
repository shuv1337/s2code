// @effect-diagnostics nodeBuiltinImport:off -- Offline artifact fixtures validate real manifest and checksum preparation, never publication.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { prepareForkAssets, inspectForkNpmPackages } from "./fork-release.ts";
import { npmLauncherPackageManifest } from "./build-npm-launcher.ts";
import { forkReleasePlan, desktopAssetGroups } from "./lib/fork-release.ts";
import { cliArchiveFileName, CLI_ARCHIVE_PLATFORM_KEYS } from "@t3tools/shared/cliRelease";
import { serializeUpdateManifest, parseUpdateManifest } from "./lib/update-manifest.ts";
const FS = NodeFS;
const OS = NodeOS;
const Path = NodePath;
const Crypto = NodeCrypto;

function fixture(
  channel: "stable" | "nightly" | "preview",
  run: (directory: string, plan: ReturnType<typeof forkReleasePlan>) => void,
  options: {
    signing?: { mac: boolean; win: boolean; unsigned: boolean };
    npm?: boolean;
    windows?: boolean;
  } = {},
) {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "fork-release-fixture-"));
  const version = channel === "stable" ? "1.2.3" : `1.2.3-${channel}.20261014.1`;
  const signing = options.signing ?? { mac: true, win: true, unsigned: false };
  const plan = forkReleasePlan({
    repository: "shuv1337/s2code",
    sha: "ab".repeat(20),
    version,
    channel,
    signing,
    npm: options.npm ?? true,
    windows: options.windows ?? true,
  });
  const desktops = desktopAssetGroups(version, plan.windows).map((group) => group[0]!);
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
          // electron-builder writes this for AppImage entries only.
          ...(url.endsWith(".AppImage") ? { blockMapSize: 211_644 } : {}),
        })),
      },
      { platformLabel: "fixture" },
    );
  try {
    for (const name of [...desktops, ...plan.cliAssets])
      FS.writeFileSync(Path.join(directory, name), `fixture bytes ${name}`);
    if (channel !== "preview") {
      const prefix = channel === "stable" ? "latest" : "nightly";
      // electron-builder writes a blockmap beside every differentially
      // updatable installer, whether or not that platform ends up signed.
      for (const name of desktops.filter((name) => !name.endsWith(".deb")))
        FS.writeFileSync(Path.join(directory, `${name}.blockmap`), `fixture blocks ${name}`);
      for (const [name, files] of [
        [
          `${prefix}-mac.yml`,
          desktops.filter((name) => name.endsWith(".zip") && name.includes("-arm64.")),
        ],
        ...(plan.windows
          ? ([
              [
                `${prefix}-win-x64.yml`,
                desktops.filter((name) => name.endsWith(".exe") && name.includes("-x64.")),
              ],
            ] as const)
          : []),
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
  it("checks the real launcher tarball: manifest, byte integrity, and the archive checksums it pins", () =>
    fixture("nightly", (assets, plan) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-npm-fixture-"));
      try {
        const sha256 = (name: string) =>
          Crypto.createHash("sha256")
            .update(FS.readFileSync(Path.join(assets, name)))
            .digest("hex");
        const pinned = Object.fromEntries(
          CLI_ARCHIVE_PLATFORM_KEYS.map((key) => {
            const archive = cliArchiveFileName(plan.version, key);
            return [key, { archive, sha256: sha256(archive) }];
          }),
        );
        const packageDirectory = NodePath.join(directory, "package");
        NodeFS.mkdirSync(packageDirectory);
        const pack = (manifest: unknown, checksums: unknown) => {
          for (const [name, value] of [
            ["package.json", manifest],
            ["checksums.json", checksums],
          ] as const)
            NodeFS.writeFileSync(NodePath.join(packageDirectory, name), JSON.stringify(value));
          NodeChildProcess.execFileSync("tar", [
            "-czf",
            NodePath.join(directory, "shuv2code.tgz"),
            "-C",
            directory,
            "package",
          ]);
        };
        const manifest = npmLauncherPackageManifest(plan.version, 79);
        pack(manifest, pinned);
        const [checked] = inspectForkNpmPackages(directory, plan, assets);
        expect(checked!.manifest.name).toBe("shuv2code");
        expect(checked!.integrity).toBe(
          `sha512-${NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(checked!.file)).digest("base64")}`,
        );
        pack({ ...manifest, name: "t3" }, pinned);
        expect(() => inspectForkNpmPackages(directory, plan, assets)).toThrow("allowlist");
        const linux = cliArchiveFileName(plan.version, "linux-x64");
        for (const checksums of [
          { ...pinned, "linux-x64": { archive: linux, sha256: "0".repeat(64) } },
          Object.fromEntries(Object.entries(pinned).filter(([key]) => key !== "win32-x64")),
        ]) {
          pack(manifest, checksums);
          expect(() => inspectForkNpmPackages(directory, plan, assets)).toThrow(
            "checksums.json does not match",
          );
        }
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }));
  it("accepts a launcher pinning only the archives that built when Windows did not", () =>
    fixture(
      "nightly",
      (assets, plan) => {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-npm-fixture-"));
        try {
          const packageDirectory = NodePath.join(directory, "package");
          NodeFS.mkdirSync(packageDirectory);
          const pack = (archives: ReadonlyArray<string>) => {
            NodeFS.writeFileSync(
              NodePath.join(packageDirectory, "package.json"),
              JSON.stringify(npmLauncherPackageManifest(plan.version, 79)),
            );
            NodeFS.writeFileSync(
              NodePath.join(packageDirectory, "checksums.json"),
              JSON.stringify(
                Object.fromEntries(
                  archives.map((archive) => [
                    archive,
                    {
                      archive,
                      sha256: FS.existsSync(Path.join(assets, archive))
                        ? Crypto.createHash("sha256")
                            .update(FS.readFileSync(Path.join(assets, archive)))
                            .digest("hex")
                        : "0".repeat(64),
                    },
                  ]),
                ),
              ),
            );
            NodeChildProcess.execFileSync("tar", [
              "-czf",
              NodePath.join(directory, "shuv2code.tgz"),
              "-C",
              directory,
              "package",
            ]);
          };
          expect(plan.cliAssets.some((name) => name.includes("win32"))).toBe(false);
          pack(plan.cliAssets);
          expect(inspectForkNpmPackages(directory, plan, assets)).toHaveLength(1);
          pack([...plan.cliAssets, cliArchiveFileName(plan.version, "win32-x64")]);
          expect(() => inspectForkNpmPackages(directory, plan, assets)).toThrow(
            "checksums.json does not match",
          );
        } finally {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }
      },
      { windows: false },
    ));
  it.each(["stable", "nightly", "preview"] as const)(
    "prepares the complete %s platform matrix and final checksums",
    (channel) =>
      fixture(channel, (directory, plan) => {
        const assets = prepareForkAssets(plan, directory);
        expect(
          assets.filter((name) => /\.(dmg|zip|AppImage|deb|exe|tar\.gz)$/.test(name)),
        ).toHaveLength(19);
        const checksums = FS.readFileSync(Path.join(directory, "SHA256SUMS"), "utf8");
        for (let index = 0; index < plan.cliAssets.length; index++) {
          const name = plan.cliAssets[index]!;
          const previousName = plan.cliPreviousAssets[index]!;
          expect(checksums).toContain(`  ${previousName}\n`);
          expect(FS.readFileSync(Path.join(directory, previousName))).toEqual(
            FS.readFileSync(Path.join(directory, name)),
          );
          const legacyName = plan.cliLegacyAssets[index]!;
          expect(checksums).toContain(`  ${name}\n`);
          expect(checksums).toContain(`  ${legacyName}\n`);
          expect(FS.readFileSync(Path.join(directory, legacyName))).toEqual(
            FS.readFileSync(Path.join(directory, name)),
          );
        }
        for (const name of plan.feedAssets) {
          const feed = parseUpdateManifest(
            FS.readFileSync(Path.join(directory, name), "utf8"),
            name,
            "fixture",
          );
          expect(feed.version).toBe(plan.version);
          if (name.includes("mac") || !name.includes("linux")) expect(feed.files).toHaveLength(1);
        }
        if (channel === "preview") expect(assets.some((name) => name.endsWith(".yml"))).toBe(false);
      }),
  );
  it("publishes an unsigned nightly without the feeds its updaters cannot follow", () =>
    fixture(
      "nightly",
      (directory, plan) => {
        const assets = prepareForkAssets(plan, directory);
        const feeds = assets.filter((name) => name.endsWith(".yml"));
        expect(feeds).toEqual(["nightly-linux.yml", "nightly-linux-arm64.yml"]);
        expect(FS.readdirSync(directory).filter((name) => name.endsWith(".yml"))).toEqual(
          expect.arrayContaining(feeds),
        );
        expect(FS.readdirSync(directory)).not.toContain("nightly-mac.yml");
        expect(FS.readdirSync(directory)).not.toContain("nightly.yml");
        // Only Linux can still update, so only its blocks are worth shipping.
        expect(assets.filter((name) => name.endsWith(".blockmap")).sort()).toEqual(
          desktopAssetGroups(plan.version)
            .map((group) => group[0]!)
            .filter((name) => name.endsWith(".AppImage"))
            .map((name) => `${name}.blockmap`)
            .sort(),
        );
        const release = JSON.parse(
          FS.readFileSync(Path.join(directory, "release.json"), "utf8"),
        ) as { npmPackages: string[]; signing: { unsigned: boolean } };
        expect(release.npmPackages).toEqual([]);
        expect(release.signing.unsigned).toBe(true);
      },
      { signing: { mac: false, win: false, unsigned: true }, npm: false },
    ));
  it("keeps the macOS feed and blocks when only Windows is unsigned", () =>
    fixture(
      "nightly",
      (directory, plan) => {
        const assets = prepareForkAssets(plan, directory);
        expect(assets.filter((name) => name.endsWith(".yml"))).toEqual([
          "nightly-mac.yml",
          "nightly-linux.yml",
          "nightly-linux-arm64.yml",
        ]);
        const blocks = assets.filter((name) => name.endsWith(".blockmap"));
        expect(blocks.some((name) => name.endsWith(".dmg.blockmap"))).toBe(true);
        expect(blocks.some((name) => name.endsWith(".zip.blockmap"))).toBe(true);
        expect(blocks.some((name) => name.endsWith(".exe.blockmap"))).toBe(false);
        const checksums = FS.readFileSync(Path.join(directory, "SHA256SUMS"), "utf8");
        expect(checksums).not.toContain(".exe.blockmap");
        expect(checksums).toContain(".dmg.blockmap");
      },
      { signing: { mac: true, win: false, unsigned: true } },
    ));
  it("leaves out a failed Windows build, including the CLI archive it uploaded first", () =>
    fixture(
      "nightly",
      (directory, plan) => {
        FS.writeFileSync(
          Path.join(directory, cliArchiveFileName(plan.version, "win32-x64")),
          "uploaded before the Windows build failed",
        );
        const launcher = { name: "shuv2code", integrity: "sha512-fixture" };
        const assets = prepareForkAssets(plan, directory, [launcher]);
        expect(
          FS.readdirSync(directory).filter(
            (name) => name.includes("win32") || name.includes(".exe"),
          ),
        ).toEqual([]);
        expect(assets.filter((name) => name.endsWith(".yml"))).toEqual([
          "nightly-mac.yml",
          "nightly-linux.yml",
          "nightly-linux-arm64.yml",
        ]);
        expect(FS.readFileSync(Path.join(directory, "SHA256SUMS"), "utf8")).not.toContain("win32");
        const release = JSON.parse(
          FS.readFileSync(Path.join(directory, "release.json"), "utf8"),
        ) as { windows: boolean; npmPackages: unknown };
        expect(release.windows).toBe(false);
        expect(release.npmPackages).toEqual([launcher]);
      },
      { windows: false },
    ));
  it("rejects missing CLI platforms before publishing", () =>
    fixture("stable", (directory, plan) => {
      FS.unlinkSync(Path.join(directory, plan.cliAssets[0]!));
      expect(() => prepareForkAssets(plan, directory)).toThrow("Missing required CLI");
    }));
  it("rejects wrong feed bytes and preview automatic metadata", () => {
    fixture("stable", (directory, plan) => {
      FS.appendFileSync(Path.join(directory, `S2Code-${plan.version}-arm64.zip`), "changed");
      expect(() => prepareForkAssets(plan, directory)).toThrow("changed release bytes");
    });
    fixture("preview", (directory, plan) => {
      FS.writeFileSync(Path.join(directory, "latest.yml"), "foreign updater");
      expect(() => prepareForkAssets(plan, directory)).toThrow("Preview releases");
    });
  });
});
