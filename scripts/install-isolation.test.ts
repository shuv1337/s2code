// @effect-diagnostics nodeBuiltinImport:off - Real installers use disposable homes and stubbed release assets.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const hasPwsh =
  NodeChildProcess.spawnSync(
    "pwsh",
    ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
    { encoding: "utf8" },
  ).status === 0;
const version = "1.2.3";
const platform = HostProcess.Platform.defaultValue();
const arch = HostProcess.Architecture.defaultValue();
let root: string;
let assets: string;
let fixtureBin: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-installer-")));
  home = NodePath.join(root, "user");
  assets = NodePath.join(root, "assets");
  fixtureBin = NodePath.join(root, "fixture-bin");
  [home, assets, fixtureBin].forEach((directory) => NodeFS.mkdirSync(directory));
  const stem = `shuv2code-${version}-${platform}-${arch}`;
  NodeFS.mkdirSync(NodePath.join(assets, stem));
  NodeFS.writeFileSync(NodePath.join(assets, stem, "t3"), "#!/bin/sh\necho fork-runtime\n", {
    mode: 0o755,
  });
  NodeChildProcess.execFileSync("tar", [
    "-czf",
    NodePath.join(assets, `${stem}.tar.gz`),
    "-C",
    assets,
    stem,
  ]);
  const archive = NodeFS.readFileSync(NodePath.join(assets, `${stem}.tar.gz`));
  NodeFS.writeFileSync(
    NodePath.join(assets, "SHA256SUMS"),
    `${NodeCrypto.createHash("sha256").update(archive).digest("hex")}  ${stem}.tar.gz\n`,
  );
  NodeFS.writeFileSync(NodePath.join(assets, "releases"), '[{"tag_name":"v1.2.3"}]');
  NodeFS.writeFileSync(
    NodePath.join(assets, "release.json"),
    JSON.stringify({ signing: { mac: true, win: false, unsigned: true } }),
  );
  NodeFS.writeFileSync(
    NodePath.join(fixtureBin, "curl"),
    `#!/bin/sh
out= url=
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac
  shift
done
case "$url" in *SHA256SUMS) file=SHA256SUMS ;; *.tar.gz) file="${stem}.tar.gz" ;; *release.json) file=release.json ;; *) file=releases ;; esac
if [ -n "\${FIXTURE_PRODUCT_HOME:-}" ]; then
  [ "$(cat "$FIXTURE_PRODUCT_HOME/.product-identity" 2>/dev/null)" = shuv2code ] || exit 91
fi
cp "$FIXTURE_ASSETS/$file" "$out"
printf '%s\\n' "$url" >> "$FIXTURE_REQUESTS"
printf 200
`,
    { mode: 0o755 },
  );
  env = {
    PATH: `${fixtureBin}:${process.env.PATH}`,
    HOME: home,
    TERM: "dumb",
    FIXTURE_ASSETS: assets,
    FIXTURE_REQUESTS: NodePath.join(root, "requests"),
    SHUV2CODE_VERSION: version,
    SHUV2CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
    SHUV2CODE_RELEASE_BASE_URL: "https://fixture.invalid/releases/download",
    T3CODE_HOME: NodePath.join(home, ".t3"),
    T3CODE_PORT: "3773",
    T3CODE_VERSION: "9.9.9",
    T3CODE_RELEASE_BASE_URL: "https://upstream.invalid",
    PROCESSOR_ARCHITECTURE: "AMD64",
    ...Object.fromEntries(
      ["SystemRoot", "TMPDIR", "TEMP", "TMP"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
  };
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

function runInstaller(kind: "sh" | "pwsh") {
  if (kind === "sh")
    return NodeChildProcess.spawnSync("sh", [NodePath.join(import.meta.dirname, "install.sh")], {
      env,
      encoding: "utf8",
    });
  const powershell = NodePath.join(root, "fixture.ps1");
  const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  NodeFS.writeFileSync(NodePath.join(assets, "windows.zip"), "fixture archive");
  const digest = NodeCrypto.createHash("sha256").update("fixture archive").digest("hex");
  NodeFS.writeFileSync(
    powershell,
    `
Set-Variable HOME ${psQuote(home)} -Force
if ($env:FIXTURE_FAIL_PUBLISH) {
  function Move-Item {
    [CmdletBinding()] param([Parameter(ValueFromPipeline=$true)] $InputObject, $Path, $LiteralPath, $Destination)
    process {
      $source = if ($LiteralPath) { $LiteralPath } elseif ($Path) { $Path } else { $InputObject.FullName }
      if ([string]$source -match '[\\\\/]\\.staging-' -and [IO.Path]::GetFileName($Destination) -eq '1.2.3') { throw 'injected publish failure' }
      Microsoft.PowerShell.Management\\Move-Item -LiteralPath $source -Destination $Destination -ErrorAction Stop
    }
  }
}
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing, $Headers)
  if ($env:FIXTURE_PRODUCT_HOME -and [IO.File]::ReadAllText((Join-Path $env:FIXTURE_PRODUCT_HOME '.product-identity')).Trim() -ne 'shuv2code') { throw 'Missing home ownership before download' }
  Add-Content $env:FIXTURE_REQUESTS $Uri
  $archiveStem = if ($env:FIXTURE_LEGACY_ARCHIVE) { 't3-1.2.3-win32-x64' } else { 'shuv2code-1.2.3-win32-x64' }
  # Release assets are octet-stream, so the real cmdlet hands back raw bytes.
  if ($Uri.EndsWith('release.json')) { return [pscustomobject]@{ Content = [IO.File]::ReadAllBytes(${psQuote(NodePath.join(assets, "release.json"))}) } }
  if ($Uri.EndsWith('SHA256SUMS')) { [IO.File]::WriteAllText($OutFile, "${digest}  $archiveStem.zip") }
  else { Copy-Item ${psQuote(NodePath.join(assets, "windows.zip"))} $OutFile }
}
function Invoke-RestMethod { param($Uri, $Headers) Add-Content $env:FIXTURE_REQUESTS $Uri; return @{ tag_name = 'v1.2.3'; draft = $false } }
function Expand-Archive { param($Path, $DestinationPath, [switch]$Force)
  $archiveStem = if ($env:FIXTURE_LEGACY_ARCHIVE) { 't3-1.2.3-win32-x64' } else { 'shuv2code-1.2.3-win32-x64' }
  $directory = Join-Path $DestinationPath $archiveStem
  New-Item -ItemType Directory $directory | Out-Null
  Copy-Item ${psQuote(NodePath.join(assets, `shuv2code-${version}-${platform}-${arch}`, "t3"))} (Join-Path $directory 't3.exe')
  & chmod +x (Join-Path $directory 't3.exe')
}
. ${psQuote(NodePath.join(import.meta.dirname, "install.ps1"))}
`,
  );
  return NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-File", powershell], {
    env,
    encoding: "utf8",
  });
}
function seedCache(directory: string, marker: string, kind: "sh" | "pwsh") {
  const cache = NodePath.join(directory, "runtime", "versions", version);
  NodeFS.mkdirSync(cache, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cache, ".install-complete"), marker);
  NodeFS.writeFileSync(NodePath.join(cache, kind === "sh" ? "t3" : "t3.exe"), "upstream-sentinel", {
    mode: 0o755,
  });
  return cache;
}
describe
  .skipIf(platform === "win32" || (platform === "darwin" && arch !== "arm64"))
  .each(["sh", "pwsh"] as const)("%s installer isolation", (kind) => {
  it.skipIf(kind === "pwsh" && !hasPwsh).each(["nightly", "preview"])(
    "claims a fresh %s home before downloading or populating runtime state",
    (channel) => {
      env.SHUV2CODE_HOME = NodePath.join(home, `.shuv2code-v2-${channel}`);
      env.FIXTURE_PRODUCT_HOME = env.SHUV2CODE_HOME;
      const result = runInstaller(kind);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(
        NodeFS.readFileSync(NodePath.join(env.SHUV2CODE_HOME, ".product-identity"), "utf8").trim(),
      ).toBe("shuv2code");
      expect(
        NodeFS.readFileSync(
          NodePath.join(env.SHUV2CODE_HOME, "runtime", "versions", version, ".install-product"),
          "utf8",
        ).trim(),
      ).toBe("shuv2code");
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)("warns about an unsigned release and installs it", () => {
    const result = runInstaller(kind);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    // PowerShell's warning stream reaches stdout on these hosts.
    expect(result.stderr + result.stdout).toContain("UNSIGNED build");
  });
  it.skipIf(kind === "pwsh" && !hasPwsh).each(["nightly", "preview"])(
    "rejects unmarked upstream-like state at the exact %s default before changing any files",
    (channel) => {
      env.SHUV2CODE_VERSION = `1.2.3-${channel}.20261014.1`;
      const channelHome = NodePath.join(home, `.shuv2code-v2-${channel}`);
      const userdata = NodePath.join(channelHome, "userdata");
      NodeFS.mkdirSync(userdata, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(userdata, "statev2.sqlite"), "upstream-state");
      env.T3CODE_HOME = channelHome;
      const result = runInstaller(kind);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Cannot establish product ownership");
      expect(NodeFS.readFileSync(NodePath.join(userdata, "statev2.sqlite"), "utf8")).toBe(
        "upstream-state",
      );
      expect(NodeFS.readdirSync(channelHome)).toEqual(["userdata"]);
      expect(NodeFS.existsSync(NodePath.join(home, ".shuv2code-v2"))).toBe(false);
      expect(NodeFS.existsSync(env.FIXTURE_REQUESTS!)).toBe(false);
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)(
    "restores the old cache and installed command when publication fails",
    () => {
      const cache = seedCache(NodePath.join(home, ".shuv2code-v2"), version, kind);
      NodeFS.mkdirSync(env.SHUV2CODE_INSTALL_BIN_DIR!, { recursive: true });
      const command = NodePath.join(
        env.SHUV2CODE_INSTALL_BIN_DIR!,
        kind === "sh" ? "shuv2code" : "shuv2code.cmd",
      );
      if (kind === "sh") NodeFS.symlinkSync(NodePath.join(cache, "t3"), command);
      else NodeFS.writeFileSync(command, "previous-windows-shim");
      env.FIXTURE_FAIL_PUBLISH = "true";
      if (kind === "sh")
        NodeFS.writeFileSync(
          NodePath.join(fixtureBin, "mv"),
          '#!/bin/sh\ncase "$1" in */.staging-*) exit 55 ;; esac\nexec /bin/mv "$@"\n',
          { mode: 0o755 },
        );
      const result = runInstaller(kind);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(
        NodeFS.readFileSync(NodePath.join(cache, kind === "sh" ? "t3" : "t3.exe"), "utf8"),
      ).toBe("upstream-sentinel");
      expect(NodeFS.readFileSync(NodePath.join(cache, ".install-complete"), "utf8")).toBe(version);
      expect(NodeFS.readdirSync(NodePath.dirname(cache))).toEqual([version]);
      expect(NodeFS.readFileSync(command, "utf8")).toBe(
        kind === "sh" ? "upstream-sentinel" : "previous-windows-shim",
      );
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh).each(["", "shuv", "shuv2cod"])(
    "recovers an incomplete marker %j only inside the known default home",
    (marker) => {
      const directory = NodePath.join(home, ".shuv2code-v2");
      const cache = seedCache(directory, version, kind);
      NodeFS.writeFileSync(NodePath.join(directory, ".product-identity"), marker);
      NodeFS.writeFileSync(NodePath.join(cache, ".install-product"), marker);
      const result = runInstaller(kind);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(
        NodeFS.readFileSync(NodePath.join(directory, ".product-identity"), "utf8").trim(),
      ).toBe("shuv2code");
      expect(NodeFS.readFileSync(NodePath.join(cache, ".install-product"), "utf8").trim()).toBe(
        "shuv2code",
      );
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)(
    "ignores inherited upstream home, version and release origin",
    () => {
      env.T3CODE_VERSION = version;
      env.SHUV2CODE_CHANNEL = "stable";
      delete env.SHUV2CODE_VERSION;
      delete env.SHUV2CODE_RELEASE_BASE_URL;
      const upstream = seedCache(env.T3CODE_HOME!, version, kind);
      const result = runInstaller(kind);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const requests = NodeFS.readFileSync(env.FIXTURE_REQUESTS!, "utf8").trim().split(/\r?\n/);
      expect(requests.every((url) => url.includes("shuv1337/shuv2code"))).toBe(true);
      expect(
        NodeFS.readFileSync(NodePath.join(upstream, kind === "sh" ? "t3" : "t3.exe"), "utf8"),
      ).toBe("upstream-sentinel");
      expect(
        NodeFS.readFileSync(
          NodePath.join(home, ".shuv2code-v2", "runtime", "versions", version, ".install-complete"),
          "utf8",
        ).trim(),
      ).toBe(version);
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)(
    "follows the nightly train by default and never falls back to stable",
    () => {
      delete env.SHUV2CODE_VERSION;
      const result = runInstaller(kind);
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("could not find a nightly release");
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)(
    "honors a fork-owned custom home and rejects same-version foreign metadata",
    () => {
      const custom = NodePath.join(root, "custom");
      env.SHUV2CODE_HOME = custom;
      NodeFS.mkdirSync(custom);
      NodeFS.writeFileSync(NodePath.join(custom, ".product-identity"), "shuv2code");
      const cache = seedCache(custom, version, kind);
      NodeFS.writeFileSync(NodePath.join(cache, ".install-product"), "t3code\n");
      const result = runInstaller(kind);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("foreign runtime cache");
      expect(NodeFS.readFileSync(NodePath.join(cache, ".install-complete"), "utf8")).toBe(version);
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)(
    "refetches unmarked caches without executing the upstream sentinel",
    () => {
      const cache = seedCache(NodePath.join(home, ".shuv2code-v2"), version, kind);
      const result = runInstaller(kind);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stderr).not.toContain("already downloaded");
      expect(NodeFS.readFileSync(NodePath.join(cache, ".install-complete"), "utf8").trim()).toBe(
        version,
      );
      expect(NodeFS.readFileSync(NodePath.join(cache, ".install-product"), "utf8").trim()).toBe(
        "shuv2code",
      );
      expect(
        NodeFS.readFileSync(NodePath.join(cache, kind === "sh" ? "t3" : "t3.exe"), "utf8"),
      ).not.toBe("upstream-sentinel");
      const repeat = runInstaller(kind);
      expect(repeat.status, repeat.stderr).toBe(0);
      expect(repeat.stderr).toContain("already downloaded");
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)("installs into an empty explicit fork home", () => {
    env.SHUV2CODE_HOME = NodePath.join(root, "custom");
    const result = runInstaller(kind);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(
      NodeFS.readFileSync(
        NodePath.join(env.SHUV2CODE_HOME, "runtime", "versions", version, ".install-complete"),
        "utf8",
      ).trim(),
    ).toBe(version);
  });
  it.skipIf(kind !== "pwsh" || !hasPwsh)(
    "falls back to a pre-rename Windows archive and its checksum entry",
    () => {
      env.FIXTURE_LEGACY_ARCHIVE = "1";
      const result = runInstaller(kind);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(NodeFS.readFileSync(env.FIXTURE_REQUESTS!, "utf8")).toContain(
        "/t3-1.2.3-win32-x64.zip",
      );
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh)(
    "refuses foreign product metadata even in the default fork namespace",
    () => {
      const cache = seedCache(NodePath.join(home, ".shuv2code-v2"), "t3code\n1.2.3\n", kind);
      NodeFS.writeFileSync(NodePath.join(cache, ".install-product"), "t3code\n");
      const result = runInstaller(kind);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("foreign runtime cache");
      expect(NodeFS.readFileSync(NodePath.join(cache, ".install-complete"), "utf8")).toBe(
        "t3code\n1.2.3\n",
      );
    },
  );
  it.skipIf(kind === "pwsh" && !hasPwsh).each([".t3", ".T3"])(
    "refuses an explicit upstream home %s without altering it",
    (name) => {
      env.SHUV2CODE_HOME = NodePath.join(home, name);
      const cache = seedCache(env.SHUV2CODE_HOME, version, kind);
      const result = runInstaller(kind);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("upstream .t3 home");
      expect(NodeFS.readFileSync(NodePath.join(cache, ".install-complete"), "utf8")).toBe(version);
      expect(NodeFS.existsSync(NodePath.join(env.SHUV2CODE_HOME, ".product-identity"))).toBe(false);
    },
  );
});
