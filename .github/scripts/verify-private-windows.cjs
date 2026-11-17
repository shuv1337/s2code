const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { oneFile, sha256 } = require("./encrypted-windows-delivery.cjs");

function peSignature(buffer) {
  if (buffer.length < 64 || buffer.toString("ascii", 0, 2) !== "MZ") return null;
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 > buffer.length || buffer.toString("hex", pe, pe + 4) !== "50450000") return null;
  const optional = pe + 24;
  if (optional + 2 > buffer.length) throw new Error("Truncated PE optional header.");
  const magic = buffer.readUInt16LE(optional);
  const directory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0);
  if (directory === optional || directory + 40 > buffer.length)
    throw new Error("Malformed PE optional header.");
  const offset = buffer.readUInt32LE(directory + 32);
  const size = buffer.readUInt32LE(directory + 36);
  if (size < 8 || offset + size > buffer.length)
    throw new Error("Unsigned or invalid PE certificate table.");
  const length = buffer.readUInt32LE(offset);
  if (length < 8 || length > size || buffer.readUInt16LE(offset + 6) !== 2)
    throw new Error("Expected a PKCS#7 Authenticode signature.");
  return buffer.subarray(offset + 8, offset + length);
}
function filesUnder(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Unexpected symlink in extracted Windows payload.");
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}
// This workflow builds only the nightly product. NSIS embeds its uninstaller
// outside app-64.7z; plugin helper DLLs are not installed application components.
const EXPECTED_UNINSTALLER = "Uninstall S2Code (Nightly).exe";
function findUninstaller(root) {
  const candidates = filesUnder(root).filter((file) =>
    /^uninstall .*\.exe$/i.test(path.basename(file)),
  );
  if (candidates.length !== 1 || path.basename(candidates[0]) !== EXPECTED_UNINSTALLER)
    throw new Error("Expected one unique S2Code nightly NSIS uninstaller.");
  return candidates[0];
}
function unpack(archive, destination) {
  fs.mkdirSync(destination, { recursive: false });
  execFileSync("7z", ["x", "-y", `-o${destination}`, archive], { stdio: "pipe" });
}
function windowsVerifier() {
  return String.raw`param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$ExpectedPublisher, [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceSha, [switch]$RunRuntimeChecks)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path $Root).Path
$report = Get-Content (Join-Path $Root 'verification.json') -Raw | ConvertFrom-Json
if ($report.expectedPublisher -cne $ExpectedPublisher) { throw 'Unexpected publisher in verification evidence' }
$provenance = Get-Content (Join-Path $Root 'provenance.json') -Raw | ConvertFrom-Json
if ($report.sourceSha -cne $ExpectedSourceSha -or $provenance.sourceSha -cne $ExpectedSourceSha) { throw 'Unexpected source SHA; compare against the trusted workflow run' }
if ($report.sourceSha -cne $provenance.sourceSha -or $report.version -cne $provenance.version) { throw 'Source/version evidence mismatch' }
foreach ($item in $provenance.files) {
  $candidate = Join-Path $Root $item.name
  if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) { throw "Delivery hash mismatch: $($item.name)" }
}
$seven = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source
if (!$seven) { $seven = Join-Path $env:ProgramFiles '7-Zip\7z.exe' }
if (!(Test-Path -LiteralPath $seven)) { throw '7-Zip is required to inspect installer contents before installation' }
$temp = Join-Path $env:TEMP ('s2code-signature-check-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
function Expand-Checked($Archive, $Destination) {
  New-Item -ItemType Directory -Path $Destination | Out-Null
  & $seven x -y "-o$Destination" $Archive | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Archive extraction failed' }
}
try {
  $installer = @(Get-ChildItem -LiteralPath $Root -Filter '*.exe')
  $cli = @(Get-ChildItem -LiteralPath $Root -Filter '*.zip')
  if ($installer.Count -ne 1 -or $cli.Count -ne 1) { throw 'Expected exactly one installer and CLI zip' }
  Expand-Checked $installer[0].FullName (Join-Path $temp 'installer')
  $appArchive = @(Get-ChildItem -LiteralPath (Join-Path $temp 'installer') -Recurse -Filter 'app-64.7z')
  if ($appArchive.Count -ne 1) { throw 'Missing unique x64 application payload' }
  Expand-Checked $appArchive[0].FullName (Join-Path $temp 'app')
  Expand-Checked $cli[0].FullName (Join-Path $temp 'cli')
  $installerContents = Join-Path $temp 'installer'
  $uninstaller = @(Get-ChildItem -LiteralPath $installerContents -Recurse -File | Where-Object { $_.Name -match '^uninstall .*\.exe$' })
  if ($uninstaller.Count -ne 1 -or $uninstaller[0].Name -cne 'Uninstall S2Code (Nightly).exe') { throw 'Expected one unique S2Code nightly NSIS uninstaller' }
  $uninstallerRelative = $uninstaller[0].FullName.Substring($installerContents.Length + 1).Replace([char]92, [char]47)
  $observed = @("installer/$($installer[0].Name)", "nsis-uninstaller/$uninstallerRelative")
  foreach ($area in @('app', 'cli')) {
    $base = Join-Path $temp $area
    foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File) {
      $stream = [System.IO.File]::OpenRead($file.FullName)
      $reader = [System.IO.BinaryReader]::new($stream)
      try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) { continue }
        $stream.Position = 0x3c
        $offset = $reader.ReadUInt32()
        if ($offset + 4 -gt $stream.Length) { continue }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -eq 0x4550) {
          $relative = $file.FullName.Substring($base.Length + 1).Replace('\', '/')
          $observed += "$area/$relative"
        }
      } finally { $reader.Dispose(); $stream.Dispose() }
    }
  }
  $expected = @($report.files | ForEach-Object { "$($_.area)/$($_.path)" })
  if (Compare-Object ($observed | Sort-Object) ($expected | Sort-Object)) { throw 'Execution inventory does not match actual payload' }
  if ((Get-FileHash -LiteralPath (Join-Path $temp 'app/resources/app-update.yml') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $report.updateConfiguration.sha256) { throw 'Updater configuration hash mismatch' }
  $validated = 0
  foreach ($item in $report.files) {
    if ($item.area -eq 'installer') { $candidate = $installer[0].FullName }
    elseif ($item.area -eq 'nsis-uninstaller') { $candidate = $uninstaller[0].FullName }
    elseif ($item.area -eq 'app' -or $item.area -eq 'cli') { $candidate = Join-Path (Join-Path $temp $item.area) $item.path }
    else { throw 'Invalid inventory area' }
    if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) { throw "Payload hash mismatch: $($item.path)" }
    $signature = Get-AuthenticodeSignature -LiteralPath $candidate
    if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode status for $($item.path): $($signature.Status)" }
    if ($signature.SignerCertificate.Subject -cne $ExpectedPublisher) { throw "Unexpected publisher: $($item.path)" }
    if (!$signature.TimeStamperCertificate) { throw "Missing trusted timestamp: $($item.path)" }
    $validated++
  }
  if ($validated -lt 5) { throw 'Incomplete execution-component inventory' }
  if ($RunRuntimeChecks) {
    $major = & node -p 'process.versions.node.split(".")[0]'
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw 'Node.js 24+ is required for runtime checks' }
    & node (Join-Path $Root 'verify-windows-desktop-artifact.mjs') --app-dir (Join-Path $temp 'app') --arch x64 --build-version $report.version
    if ($LASTEXITCODE -ne 0) { throw 'Packaged desktop native runtime verification failed' }
    & node (Join-Path $Root 'smoke-cli-archive.mjs') --archive $cli[0].FullName --expect-version $report.version
    if ($LASTEXITCODE -ne 0) { throw 'CLI archive runtime smoke test failed' }
  }
  Write-Output "Verified $validated execution components: Valid Authenticode, expected publisher and timestamp. Ready for installation testing. SmartScreen reputation is not guaranteed."
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
`;
}
function validateUpdateConfiguration(config, publisher) {
  if (config.provider !== "github" || config.owner !== "shuv1337" || config.repo !== "s2code")
    throw new Error("Unexpected Windows updater destination.");
  const publishers = Array.isArray(config.publisherName)
    ? config.publisherName
    : [config.publisherName];
  if (publishers.length !== 1 || publishers[0] !== publisher)
    throw new Error("Unexpected Windows updater publisher.");
  if (config.url || config.host || config.private || config.token)
    throw new Error("Unexpected Windows updater endpoint or authentication override.");
  return { provider: "github", owner: "shuv1337", repo: "s2code", publisherName: publishers };
}
async function verify({ root, source, version, publisher }) {
  if (
    !/^[a-f0-9]{40}$/.test(source) ||
    !/^\d+\.\d+\.\d+-nightly\.ci\.\d+$/.test(version) ||
    !publisher.startsWith("CN=")
  )
    throw new Error("Invalid verification metadata.");
  const installer = oneFile(path.join(root, "windows-desktop"), ".exe");
  const cli = oneFile(path.join(root, "windows-cli"), ".zip");
  const extracted = path.join(root, "verification-extracted");
  fs.mkdirSync(extracted);
  try {
    unpack(installer, path.join(extracted, "installer"));
    const archives = filesUnder(path.join(extracted, "installer")).filter(
      (file) => path.basename(file) === "app-64.7z",
    );
    if (archives.length !== 1) throw new Error("Expected a unique NSIS x64 application payload.");
    unpack(archives[0], path.join(extracted, "app"));
    unpack(cli, path.join(extracted, "cli"));
    if (!fs.existsSync(path.join(extracted, "app", "resources", "app.asar")))
      throw new Error("Incomplete Electron payload.");
    const uninstaller = findUninstaller(path.join(extracted, "installer"));
    const entries = [
      { area: "installer", path: path.basename(installer), file: installer },
      {
        area: "nsis-uninstaller",
        path: path
          .relative(path.join(extracted, "installer"), uninstaller)
          .split(path.sep)
          .join("/"),
        file: uninstaller,
      },
    ];
    for (const area of ["app", "cli"]) {
      for (const file of filesUnder(path.join(extracted, area))) {
        const buffer = fs.readFileSync(file);
        if (peSignature(buffer))
          entries.push({
            area,
            path: path.relative(path.join(extracted, area), file).split(path.sep).join("/"),
            file,
          });
      }
    }
    if (
      entries.length < 5 ||
      !entries.some((e) => e.area === "cli") ||
      !entries.some((e) => e.area === "app" && e.path.includes("server.asar.unpacked"))
    )
      throw new Error("Incomplete signed execution-component inventory.");
    const inventory = [];
    for (const entry of entries) {
      if (!peSignature(fs.readFileSync(entry.file))) throw new Error("Installer is not signed PE.");
      const check = spawnSync("osslsigncode", ["verify", "-in", entry.file], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      if (check.error) throw check.error;
      inventory.push({
        area: entry.area,
        path: entry.path,
        sha256: await sha256(entry.file),
        embeddedAuthenticode: true,
        linuxTrustVerified: check.status === 0,
      });
    }
    const updateFile = path.join(extracted, "app", "resources", "app-update.yml");
    const updateConfig = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))",
          updateFile,
        ],
        { encoding: "utf8" },
      ),
    );
    const updateConfiguration = {
      ...validateUpdateConfiguration(updateConfig, publisher),
      sha256: await sha256(updateFile),
    };
    const report = {
      updateConfiguration,
      sourceSha: source,
      version,
      expectedPublisher: publisher,
      windowsTrustVerified: false,
      windowsTrustVerificationRequiredBeforeInstall: true,
      files: inventory,
    };
    fs.writeFileSync(path.join(root, "verification.json"), JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
    fs.writeFileSync(path.join(root, "verify-windows.ps1"), windowsVerifier(), { flag: "wx" });
    console.log(
      `Inventoried ${inventory.length} signed PE components. Windows publisher/timestamp/trust verification is required before installation.`,
    );
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}
module.exports = {
  peSignature,
  filesUnder,
  findUninstaller,
  windowsVerifier,
  validateUpdateConfiguration,
  verify,
};
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i].replace(/^--/, "")] = args[i + 1];
  verify(options).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
