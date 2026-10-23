// @effect-diagnostics nodeBuiltinImport:off -- Disposable package trees and offline publisher fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";
import { PRODUCT_ID } from "@t3tools/shared/productIdentity";
import { createBuildConfig } from "./build-desktop-artifact.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const aurRoot = NodePath.join(repoRoot, "packaging/aur");

it("ignores downloaded fork AUR licenses without hiding recipes", () => {
  for (const name of ["s2code-bin", "s2code-nightly-bin"]) {
    const license = `packaging/aur/${name}/${name}-1.2.3-LICENSE`;
    const ignored = NodeChildProcess.spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: repoRoot,
      input: `${license}\npackaging/aur/${name}/PKGBUILD\n`,
      encoding: "utf8",
    });
    expect(ignored.status).toBe(0);
    expect(ignored.stdout.trim()).toBe(license);
  }
});
const versions = ["1.2.3", "1.2.3-nightly.20261014.1", "1.2.3-preview.20261014.1"];
const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const shellIt = it.skipIf(windowsHost);
let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "linux-packages-"));
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

// Baseline: pingdotgg/t3code a3c4e9e9360d65225fb726ebfe460427a6874741,
// build-desktop-artifact.ts Linux/FPM config and packaging/aur/*/PKGBUILD.
// Include namespaces, not just today's leaf files, to catch new colliding payload files.
const upstreamPaths = [
  /^\/opt\/T3 Code(?:[ /]|$)/,
  /^\/opt\/t3code(?:-bin|-nightly-bin)(?:\/|$)/,
  /^\/usr\/bin\/t3code(?:-nightly)?$/,
  /^\/usr\/bin\/t3-code(?:-nightly)?-desktop$/,
  /^\/usr\/share\/applications\/t3code.*\.desktop$/,
  /^\/usr\/share\/metainfo\/com\.t3tools\.t3code.*$/,
  /^\/usr\/share\/doc\/t3code(?:[/-]|$)/,
  /^\/usr\/share\/licenses\/t3code(?:-bin|-nightly-bin)(?:\/|$)/,
  /^\/usr\/share\/icons\/.*\/apps\/t3code.*$/,
  /^\/usr\/share\/mime\/packages\/t3code.*$/,
];
function noUpstreamPaths(files: string[]) {
  expect(files.filter((file) => upstreamPaths.some((pattern) => pattern.test(file)))).toEqual([]);
}
const configFor = (version: string) =>
  createBuildConfig("linux", "AppImage", version, false, false, undefined, undefined).pipe(
    Effect.provide(
      Layer.mergeAll(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })), NodeServices.layer),
    ),
  );

it.effect(
  "computes disjoint Debian product-owned destinations and matching AppStream metadata from build configs",
  () =>
    Effect.gen(function* () {
      const manifests: string[][] = [];
      for (const version of versions) {
        const identity = resolveChannelIdentity(version);
        const config = yield* configFor(version);
        const linux = config.linux as {
          executableName: string;
          desktop: { entry: { StartupWMClass: string } };
          protocols: { schemes: string[] }[];
        };
        const deb = config.deb as { packageName: string; fpm: string[] };
        expect(deb.packageName).toBe(identity.executableName);
        expect(linux.executableName).toBe(identity.executableName);
        expect(linux.desktop.entry.StartupWMClass).toBe(identity.executableName);
        expect(linux.protocols.flatMap((entry) => entry.schemes)).toEqual([
          identity.scheme,
          identity.scheme.replace("s2code", "shuv2code"),
        ]);
        expect(deb).toMatchObject({
          replaces: [identity.executableName.replace("s2code", "shuv2code")],
          conflicts: [identity.executableName.replace("s2code", "shuv2code")],
        });
        expect(deb).not.toHaveProperty("provides");
        // electron-builder 26.15.6 FpmTarget maps the app tree to /opt/<sanitizedProductName>,
        // executableName to desktop/icons, and the after-install script creates its command link.
        // This reconstructed inventory is not proof of final package contents:
        // inspect real DEBs with dpkg-deb --contents and Arch packages with
        // pacman -Qlp before release, including the extracted AppImage layout.
        // These product names contain no filename characters that need sanitizing.
        const files = [
          `/opt/${String(config.productName)}/resources/app.asar`,
          `/opt/${String(config.productName)}/${linux.executableName}`,
          `/usr/bin/${linux.executableName}`,
          `/usr/share/applications/${linux.executableName}.desktop`,
          `/etc/apparmor.d/${linux.executableName}`,
          ...[16, 22, 24, 32, 48, 64, 128, 256, 512].map(
            (size) => `/usr/share/icons/hicolor/${size}x${size}/apps/${linux.executableName}.png`,
          ),
          ...deb.fpm.map((mapping) => mapping.slice(mapping.indexOf("=") + 1)),
        ];
        const metainfo = deb.fpm.find((mapping) => mapping.includes("/usr/share/metainfo/"))!;
        const [source, destination] = metainfo.split("=");
        expect(destination).toBe(`/usr/share/metainfo/${identity.appId}.metainfo.xml`);
        const xml = NodeFS.readFileSync(source!, "utf8");
        expect(xml).toContain(`<id>${identity.appId}</id>`);
        expect(xml).toContain(
          `<launchable type="desktop-id">${linux.executableName}.desktop</launchable>`,
        );
        expect(xml).toContain(`<icon type="stock">${linux.executableName}</icon>`);
        expect(xml).toContain(`<binary>${linux.executableName}</binary>`);
        noUpstreamPaths(files);
        for (const previous of manifests)
          expect(files.filter((file) => previous.includes(file))).toEqual([]);
        manifests.push(files);
      }
    }),
);

// Only host-tool portability is stubbed: package() itself runs from the real recipes.
// Publishing tools are deliberately offline; even an erroneous remote is only recorded.
function tools() {
  const bin = NodePath.join(root, "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  const script = NodePath.join(root, "tools.cjs");
  NodeFS.writeFileSync(
    script,
    String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const [tool, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify({tool, args}) + '\n');
if (tool === 'install') {
  if (args.includes('-d')) { for (const p of args.filter(x => !x.startsWith('-'))) fs.mkdirSync(p, {recursive:true}); }
  else { const [from, to] = args.slice(-2); fs.mkdirSync(path.dirname(to), {recursive:true}); fs.writeFileSync(to, from === '/dev/stdin' ? fs.readFileSync(0) : fs.readFileSync(from)); }
} else if (tool === 'cp') {
  const sources = args.filter(x => !x.startsWith('-')); const to = sources.pop();
  for (const from of sources) {
    if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, {recursive:true});
    else fs.copyFileSync(from, fs.existsSync(to) && fs.statSync(to).isDirectory() ? path.join(to,path.basename(from)) : to);
  }
} else if (tool === 'id') console.log('1000');
else if (tool === 'gh') {
  if (args.some(x => x.includes('contents/LICENSE'))) process.stdout.write('fork fixture license\n');
  else console.log(JSON.stringify({assets:[{name:process.env.FIXTURE_ASSET, digest:'sha256:'+'a'.repeat(64)}]}));
} else if (tool === 'jq') {
  const json = JSON.parse(fs.readFileSync(0,'utf8')); const name = args[args.indexOf('--arg')+2];
  console.log(json.assets.find(x => x.name === name)?.digest ?? '');
} else if (tool === 'sha256sum') console.log(crypto.createHash('sha256').update(fs.readFileSync(args[0])).digest('hex')+'  '+args[0]);
else if (tool === 'sed') {
  const result = cp.spawnSync('/usr/bin/sed', process.platform === 'darwin' ? ['-E','-i','',...args.slice(1)] : args, {stdio:'inherit'});
  process.exit(result.status ?? 1);
} else if (tool === 'makepkg') {
  if (args.includes('--printsrcinfo')) console.log('pkgbase = '+fs.readFileSync('PKGBUILD','utf8').match(/^pkgname=(.*)$/m)[1]);
  else if (args.includes('--packagelist')) console.log('/fixture/package.pkg.tar.zst');
} else if (tool === 'git') {
  if (args[0] === 'clone') fs.mkdirSync(args[2],{recursive:true});
  if (args[0] === 'diff') process.exit(1);
}
`,
  );
  for (const command of [
    "install",
    "cp",
    "id",
    "gh",
    "jq",
    "sha256sum",
    "sed",
    "makepkg",
    "namcap",
    "git",
  ]) {
    NodeFS.writeFileSync(
      NodePath.join(bin, command),
      `#!/bin/sh\nexec '${process.execPath}' '${script}' '${command}' "$@"\n`,
      { mode: 0o755 },
    );
  }
  return { PATH: `${bin}:${process.env.PATH}`, TRACE_FILE: NodePath.join(root, "trace") };
}
function fileList(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(directory, entry.name);
    return entry.isDirectory()
      ? fileList(full).map((file) => `${entry.name}/${file}`)
      : [entry.name];
  });
}

shellIt(
  "runs stable/nightly AUR package functions and compares their actual fixture manifests",
  () => {
    const toolEnv = tools();
    const manifests: string[][] = [];
    for (const version of versions.slice(1, 2)) {
      const identity = resolveChannelIdentity(version);
      const pkgname = `${identity.executableName}-bin`;
      const pkgdir = NodePath.join(root, pkgname, "package");
      const srcdir = NodePath.join(root, pkgname, "source");
      const payload = NodePath.join(srcdir, "squashfs-root");
      NodeFS.mkdirSync(payload, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(payload, "AppRun"), "fork launcher");
      NodeFS.writeFileSync(NodePath.join(payload, "chrome-sandbox"), "fixture sandbox");
      const icon = NodePath.join(
        payload,
        `usr/share/icons/hicolor/512x512/apps/${identity.executableName}.png`,
      );
      NodeFS.mkdirSync(NodePath.dirname(icon), { recursive: true });
      NodeFS.writeFileSync(icon, "fork icon");
      const recipe = NodePath.join(aurRoot, pkgname, "PKGBUILD");
      const source = NodeFS.readFileSync(recipe, "utf8");
      const pkgver = source.match(/^pkgver=(.*)$/m)![1]!;
      NodeFS.writeFileSync(NodePath.join(srcdir, `${pkgname}-${pkgver}-LICENSE`), "fork license");
      const result = NodeChildProcess.spawnSync("bash", ["-c", 'source "$RECIPE"; package'], {
        env: { ...process.env, ...toolEnv, RECIPE: recipe, pkgdir, srcdir },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const files = fileList(pkgdir).map((file) => `/${file}`);
      noUpstreamPaths(files);
      for (const previous of manifests)
        expect(files.filter((file) => previous.includes(file))).toEqual([]);
      manifests.push(files);
      expect(files).toContain(`/usr/bin/${identity.executableName}`);
      const desktop = NodeFS.readFileSync(
        NodePath.join(pkgdir, `usr/share/applications/${identity.executableName}.desktop`),
        "utf8",
      );
      for (const property of [
        `Exec=${identity.executableName} %U`,
        `TryExec=${identity.executableName}`,
        `Icon=${identity.executableName}`,
        `StartupWMClass=${identity.executableName}`,
        `MimeType=x-scheme-handler/${identity.scheme};`,
      ])
        expect(desktop).toContain(property);
      expect(
        NodeFS.readFileSync(NodePath.join(pkgdir, `usr/bin/${identity.executableName}`), "utf8"),
      ).toContain(`exec /opt/${pkgname}/AppRun`);
      for (const claim of ["provides", "replaces", "conflicts"])
        expect(source).toContain(`${claim}=('${pkgname.replace("s2code", "shuv2code")}')`);
      expect(
        NodeFS.readlinkSync(
          NodePath.join(
            pkgdir,
            `usr/bin/${identity.executableName.replace("s2code", "shuv2code")}`,
          ),
        ),
      ).toBe(identity.executableName);
    }
  },
);

for (const version of versions.slice(1, 2))
  it.effect.skipIf(windowsHost)(
    `publishes ${version} only to the fork AUR remote and selects the actual build artifact`,
    () =>
      Effect.gen(function* () {
        const toolEnv = tools();
        const repo = NodePath.join(root, "repo");
        NodeFS.cpSync(aurRoot, NodePath.join(repo, "packaging/aur"), { recursive: true });
        const buildConfig = yield* configFor(version);
        const desktopRequire = NodeModule.createRequire(
          NodePath.join(repoRoot, "apps/desktop/package.json"),
        );
        const builderRequire = NodeModule.createRequire(desktopRequire.resolve("electron-builder"));
        const builderUtil = builderRequire("builder-util") as {
          Arch: { x64: number };
          getArtifactArchName: (arch: number, ext: string) => string;
        };
        const asset = String(buildConfig.artifactName)
          .replace("${version}", version)
          .replace("${arch}", builderUtil.getArtifactArchName(builderUtil.Arch.x64, "AppImage"))
          .replace("${ext}", "AppImage");
        const script = NodePath.join(repo, "packaging/aur/scripts/release.sh");
        const result = NodeChildProcess.spawnSync("bash", [script], {
          env: {
            ...process.env,
            ...toolEnv,
            RELEASE_TAG: `v${version}`,
            S2CODE_AUR_PRODUCT_ID: PRODUCT_ID,
            S2CODE_AUR_RELEASE_REPO: "shuv1337/shuv2code",
            AUR_SSH_PRIVATE_KEY: "disposable-test-key",
            FIXTURE_ASSET: asset,
          },
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        const pkgname = `${resolveChannelIdentity(version).executableName}-bin`;
        const calls = NodeFS.readFileSync(toolEnv.TRACE_FILE, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { tool: string; args: string[] });
        expect(
          calls
            .filter((call) => call.tool === "git" && ["clone", "push"].includes(call.args[0]!))
            .map((call) => call.args[1]),
        ).toEqual([
          `ssh://aur@aur.archlinux.org/${pkgname}.git`,
          `ssh://aur@aur.archlinux.org/${pkgname}.git`,
        ]);
        expect(calls.find((call) => call.tool === "jq")?.args).toContain(asset);
        expect(
          calls
            .filter((call) => call.tool === "gh")
            .every((call) => call.args.some((arg) => arg.startsWith("repos/shuv1337/shuv2code/"))),
        ).toBe(true);
        const recipe = NodeFS.readFileSync(
          NodePath.join(repo, `packaging/aur/${pkgname}/PKGBUILD`),
          "utf8",
        );
        expect(recipe).toContain(`pkgver=${version.replace("-", "_")}`);
        expect(recipe).toContain("a".repeat(64));
        expect(recipe).toContain(
          NodeCrypto.createHash("sha256").update("fork fixture license\n").digest("hex"),
        );
        expect(recipe).not.toContain("UNRELEASED");
        const sources = NodeChildProcess.spawnSync(
          "bash",
          ["-c", 'source "$RECIPE_PATH"; printf "%s\\n" "${source[@]}"'],
          {
            env: {
              ...process.env,
              RECIPE_PATH: NodePath.join(repo, `packaging/aur/${pkgname}/PKGBUILD`),
            },
            encoding: "utf8",
          },
        );
        expect(sources.status, sources.stderr).toBe(0);
        expect(sources.stdout.trim().split("\n")).toEqual([
          `${asset}::https://github.com/shuv1337/shuv2code/releases/download/v${version}/${asset}`,
          `${pkgname}-${version.replace("-", "_")}-LICENSE::https://raw.githubusercontent.com/shuv1337/shuv2code/v${version}/LICENSE`,
        ]);
      }),
  );

shellIt.each([
  {},
  { S2CODE_AUR_PRODUCT_ID: PRODUCT_ID },
  { S2CODE_AUR_PRODUCT_ID: "t3code", S2CODE_AUR_RELEASE_REPO: "pingdotgg/t3code" },
  { S2CODE_AUR_PRODUCT_ID: PRODUCT_ID, S2CODE_AUR_RELEASE_REPO: "pingdotgg/t3code" },
])("rejects missing or upstream publisher identities before external tools: %j", (identity) => {
  const toolEnv = tools();
  const result = NodeChildProcess.spawnSync(
    "bash",
    [NodePath.join(aurRoot, "scripts/release.sh")],
    {
      env: {
        PATH: toolEnv.PATH,
        TRACE_FILE: toolEnv.TRACE_FILE,
        RELEASE_TAG: "v1.2.3",
        ...identity,
      },
      encoding: "utf8",
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/is required|Refusing to publish/);
  expect(NodeFS.existsSync(toolEnv.TRACE_FILE)).toBe(false);
});

shellIt.each(["v1.2.3", "v1.2.3-preview.20261014.1"])(
  "skips non-nightly AUR publication before external tools: %s",
  (tag) => {
    const toolEnv = tools();
    const result = NodeChildProcess.spawnSync(
      "bash",
      [NodePath.join(aurRoot, "scripts/release.sh")],
      {
        env: {
          PATH: toolEnv.PATH,
          TRACE_FILE: toolEnv.TRACE_FILE,
          RELEASE_TAG: tag,
          S2CODE_AUR_PRODUCT_ID: PRODUCT_ID,
          S2CODE_AUR_RELEASE_REPO: "shuv1337/shuv2code",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("only nightly");
    expect(NodeFS.existsSync(toolEnv.TRACE_FILE)).toBe(false);
  },
);
