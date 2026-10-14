# Installs the T3 Code CLI from a GitHub Release archive on Windows. Needs
# only PowerShell 5.1+; no Node, npm, or compiler.
#
#   irm https://raw.githubusercontent.com/shuv1337/shuv2code/main/scripts/install.ps1 | iex
#
# Environment:
#   SHUV2CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: stable; preview is a maintainers' test train)
#   SHUV2CODE_VERSION           exact version to install (overrides SHUV2CODE_CHANNEL)
#   SHUV2CODE_HOME              Server home directory (default: ~\.shuv2code-v2)
#   SHUV2CODE_INSTALL_BIN_DIR   where shuv2code is linked (default: ~\.local\bin)
#   SHUV2CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $SHUV2CODE_HOME\runtime\versions\<version>, the
# same layout `t3 service install` uses, so the service reuses this download.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "shuv1337/shuv2code"
$baseUrl = if ($env:SHUV2CODE_RELEASE_BASE_URL) { $env:SHUV2CODE_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
$t3Home = if ($env:SHUV2CODE_HOME) { $env:SHUV2CODE_HOME } else { Join-Path $HOME ".shuv2code-v2" }
$binDir = if ($env:SHUV2CODE_INSTALL_BIN_DIR) { $env:SHUV2CODE_INSTALL_BIN_DIR } else { Join-Path $HOME ".local\bin" }
if ($env:T3CODE_HOME -and -not $env:SHUV2CODE_HOME) {
  [Console]::Error.WriteLine("shuv2code: ignoring T3CODE_HOME; use SHUV2CODE_HOME to configure the fork's home.")
}

function Fail([string] $message) {
  Write-Error "t3 install: $message"
  exit 1
}

# Windows can briefly keep a vacated directory name locked. Never delete the
# source tree or nest it into a destination that appeared during a retry.
function Move-RuntimeDirectory([string] $source, [string] $destination) {
  for ($attempt = 0; $attempt -le 4; $attempt++) {
    try {
      if (Test-Path -LiteralPath $destination) { throw "Runtime destination is occupied: $destination" }
      Move-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 4) { throw }
      Start-Sleep -Milliseconds 50
    }
  }
}

if ($env:SHUV2CODE_IMPORT_UPSTREAM) { Fail "Upstream import is not supported; choose a separate SHUV2CODE_HOME." }
function Assert-ProductPath([string] $directory) {
  $current = [IO.Path]::GetFullPath($directory)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "Refusing a linked product path: $directory" }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
}
$t3Home = [IO.Path]::GetFullPath($t3Home)
Assert-ProductPath $t3Home
if ($t3Home -match '(^|[\\/])\.t3([\\/]|$)') { Fail "Refusing an upstream .t3 home; choose a separate SHUV2CODE_HOME." }
$defaultForkHome = [IO.Path]::GetFullPath((Join-Path $HOME ".shuv2code-v2"))
$homeMarker = Join-Path $t3Home ".product-identity"
Assert-ProductPath $homeMarker
if (Test-Path -LiteralPath $homeMarker) {
  $homeProduct = [IO.File]::ReadAllText($homeMarker).Trim()
  if (-not "shuv2code".StartsWith($homeProduct, [StringComparison]::Ordinal)) { Fail "Home belongs to another product." }
} else { $homeProduct = "" }
if ($homeProduct -cne "shuv2code" -and (Test-Path -LiteralPath $t3Home) -and @(Get-ChildItem -LiteralPath $t3Home -Force | Where-Object { $_.Name -ne '.product-identity' }).Count -gt 0 -and -not [string]::Equals($t3Home, $defaultForkHome, [StringComparison]::OrdinalIgnoreCase)) {
  Fail "Cannot establish product ownership. Choose an empty SHUV2CODE_HOME; verify old custom fork homes offline before adding .product-identity containing shuv2code."
}
foreach ($child in @("userdata", "dev", "runtime")) { Assert-ProductPath (Join-Path $t3Home $child) }
New-Item -ItemType Directory -Force -Path $t3Home | Out-Null
$homeMarkerTemp = Join-Path $t3Home (".product-identity." + [Guid]::NewGuid().ToString() + ".tmp")
try {
  Set-Content -LiteralPath $homeMarkerTemp -Value "shuv2code"
  if (Test-Path -LiteralPath $homeMarker) { [IO.File]::Replace($homeMarkerTemp, $homeMarker, "$homeMarkerTemp.previous") }
  else { [IO.File]::Move($homeMarkerTemp, $homeMarker) }
} finally {
  foreach ($temporary in @($homeMarkerTemp, "$homeMarkerTemp.previous")) {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

$terminal = -not [Console]::IsErrorRedirected -and $env:TERM -ne "dumb"
$interactive = $terminal -and $Host.UI.SupportsVirtualTerminal
if ($interactive) {
  # Legacy code pages may support ANSI escapes but not the logo or bar glyphs.
  $glyphs = -join [char[]](0x2588, 0x2580, 0x2584, 0x25A0, 0x00B7)
  $encoding = [Console]::Error.Encoding
  $interactive = $encoding.GetString($encoding.GetBytes($glyphs)) -eq $glyphs
}
$esc = [char]27
$reset = $bold = $muted = $accent = $green = ""
if ($interactive -and -not $env:NO_COLOR) {
  $reset = "$esc[0m"; $bold = "$esc[1m"; $muted = "$esc[2m"
  $accent = "$esc[94m"; $green = "$esc[32m"
}
function Step([string] $message) {
  if ($interactive) { [Console]::Error.Write("`r$esc[2K  $muted$message$reset") }
  else { [Console]::Error.WriteLine("  $message") }
}
function Draw-Download([long] $bytes, [long] $total) {
  if (-not $interactive) { return }
  $columns = [Console]::WindowWidth
  if ($columns -le 0) { $columns = 80 }
  if ($total -gt 0 -and $columns -ge 9) {
    $percent = [Math]::Min(100, [Math]::Floor($bytes * 100.0 / $total))
    $width = [Math]::Min(32, $columns - 8)
    $filled = [int][Math]::Floor($percent * $width / 100)
    $bar = ([string][char]0x25A0) * $filled
    $rest = ([string][char]0x00B7) * ($width - $filled)
    $sizes = ("  {0:F1} / {1:F1} MB" -f ($bytes / 1MB), ($total / 1MB))
    if ($width + 7 + $sizes.Length -ge $columns) { $sizes = "" }
    [Console]::Error.Write(("`r$esc[2K  $accent$bar$reset$muted$rest$reset {0,3}%" -f $percent) + "$muted$sizes$reset")
  } else {
    $line = if ($columns -ge 32) { "  Downloading  {0:F1} MB" -f ($bytes / 1MB) } else { "  {0:F1} MB" -f ($bytes / 1MB) }
    [Console]::Error.Write("`r$esc[2K" + $line.Substring(0, [Math]::Min($line.Length, $columns - 1)))
  }
}
function Fetch([string] $uri, [string] $destination, [switch] $progress) {
  if (-not $progress -or -not $interactive) {
    $ProgressPreference = if ($progress -and $terminal) { "Continue" } else { "SilentlyContinue" }
    Invoke-WebRequest -Uri $uri -OutFile $destination -UseBasicParsing
    return
  }
  # Read the response once, displaying actual bytes received at most ten times a second.
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $response = $source = $file = $null
  try {
    $response = $client.GetAsync($uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $source = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $file = [IO.File]::Create($destination)
    $buffer = New-Object byte[] 65536
    $bytes = 0L
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Draw-Download 0 $response.Content.Headers.ContentLength
    while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $file.Write($buffer, 0, $count)
      $bytes += $count
      if ($clock.ElapsedMilliseconds -ge 100) {
        Draw-Download $bytes $response.Content.Headers.ContentLength
        $clock.Restart()
      }
    }
    Draw-Download $bytes $bytes
    [Console]::Error.WriteLine()
  } finally {
    if ($file) { $file.Dispose() }
    if ($source) { $source.Dispose() }
    if ($response) { $response.Dispose() }
    $client.Dispose()
  }
}
if ($interactive) {
  # Block characters are constructed so this file also loads correctly in PowerShell 5.1.
  $mark = @(
    "########## ######## ",
    "    ###       _##^  ",
    "    ###       ####_ ",
    "    ###    _     ###",
    "    ###    #######^ "
  )
  [Console]::Error.WriteLine()
  for ($i = 0; $i -lt $mark.Length; $i++) {
    $row = $mark[$i].Replace('#', [char]0x2588).Replace('^', [char]0x2580).Replace('_', [char]0x2584)
    $label = if ($i -eq 1) { "     ${bold}shuv2code$reset" } elseif ($i -eq 2) { "     ${muted}CLI installer$reset" } else { "" }
    [Console]::Error.WriteLine("  $bold$row$reset$label")
  }
  [Console]::Error.WriteLine()
}
Step "Finding your release..."

# PROCESSOR_ARCHITEW6432 reports the real machine when a 32-bit PowerShell
# runs under WOW64; RuntimeInformation needs .NET 4.7.1+, which 5.1 hosts
# may lack.
$rawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($rawArch) {
  "AMD64" { "x64" }
  "ARM64" { "arm64" }
  default { Fail "unsupported architecture $rawArch" }
}

$channel = if ($env:SHUV2CODE_CHANNEL) { $env:SHUV2CODE_CHANNEL } else { "stable" }
$version = $env:SHUV2CODE_VERSION
if (-not $version) {
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  $tagPattern = switch ($channel) {
    "stable" { '^v\d+\.\d+\.\d+$' }
    "nightly" { '^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$' }
    "preview" { '^v\d+\.\d+\.\d+-preview\.\d+\.\d+$' }
    default { Fail "SHUV2CODE_CHANNEL must be stable, nightly, or preview" }
  }
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers @{ "User-Agent" = "t3-install" }
  $tag = ($releases | Where-Object { -not $_.draft -and $_.tag_name -match $tagPattern } | Select-Object -First 1).tag_name
  if (-not $tag) { Fail "could not find a $channel release; set SHUV2CODE_VERSION" }
  $version = $tag.Substring(1)
}
if ($version -match '-preview\.') {
  Write-Warning "t3 $version is a preview build. Preview builds are cut by maintainers from unreleased branches to exercise the release pipeline. They can be broken, receive no fixes, and are never offered as updates. Set SHUV2CODE_CHANNEL=stable (the default) for a supported build."
  if ($channel -ne "preview" -and -not $env:SHUV2CODE_VERSION) {
    Fail "refusing a preview build that was not explicitly requested"
  }
}

$stem = "t3-$version-win32-$arch"
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') { Fail "Invalid release version." }
$archive = "$stem.zip"
$versionsDir = Join-Path $t3Home "runtime\versions"
$targetDir = Join-Path $versionsDir $version
$marker = Join-Path $targetDir ".install-complete"
Assert-ProductPath $targetDir
Assert-ProductPath (Join-Path $targetDir "t3.exe")
Assert-ProductPath $marker
$productMarker = Join-Path $targetDir ".install-product"
Assert-ProductPath $productMarker
$product = if (Test-Path -LiteralPath $productMarker) { [IO.File]::ReadAllText($productMarker).Trim() } else { "" }
if (-not "shuv2code".StartsWith($product, [StringComparison]::Ordinal)) { Fail "Refusing to reuse or replace a foreign runtime cache." }
$completion = $version
$installedMarker = if (Test-Path -LiteralPath $marker) { [IO.File]::ReadAllText($marker).Trim().Replace("`r`n", "`n") } else { "" }

if ((Test-Path (Join-Path $targetDir "t3.exe")) -and $product -eq "shuv2code" -and $installedMarker -eq $completion) {
  Step "Version $version is already downloaded."
} else {
  New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
  $staging = Join-Path $versionsDir (".staging-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $staging | Out-Null
  $previous = $previousContainer = $null
  $validated = $false
  try {
    if ($interactive) { [Console]::Error.Write("`r$esc[2K") }
    [Console]::Error.WriteLine("  ${muted}Installing$reset shuv2code $bold$version$reset`n")
    Step "Downloading..."
    try {
      Fetch "$baseUrl/v$version/SHA256SUMS" (Join-Path $staging "SHA256SUMS")
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 404) {
        Fail "shuv2code $version has no release archive for win32-$arch"
      }
      throw
    }
    Fetch "$baseUrl/v$version/$archive" (Join-Path $staging $archive) -progress

    Step "Verifying the download..."

    $expected = (Get-Content (Join-Path $staging "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1)
    if (-not $expected) { Fail "$archive is not listed in SHA256SUMS" }
    $expected = ($expected -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $staging $archive)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "checksum mismatch for $archive" }

    Step "Extracting shuv2code..."
    # The archive module reads the global preference, not the caller's local scope.
    $savedProgress = $global:ProgressPreference
    try {
      $global:ProgressPreference = "SilentlyContinue"
      Expand-Archive -Path (Join-Path $staging $archive) -DestinationPath $staging -Force
    } finally { $global:ProgressPreference = $savedProgress }
    # The archive wraps everything in one directory named after its stem.
    Get-ChildItem (Join-Path $staging $stem) | Move-Item -Destination $staging
    Remove-Item (Join-Path $staging $stem), (Join-Path $staging $archive), (Join-Path $staging "SHA256SUMS") -Recurse -Force

    & (Join-Path $staging "t3.exe") --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "the downloaded executable does not run" }
    Set-Content -Path (Join-Path $staging ".install-complete") -Value "$completion`n" -NoNewline
    Set-Content -Path (Join-Path $staging ".install-product") -Value "shuv2code`n" -NoNewline

    $validated = $true
    if (Test-Path -LiteralPath $targetDir) {
      $previousContainer = Join-Path $versionsDir (".previous-" + [Guid]::NewGuid().ToString())
      New-Item -ItemType Directory -Path $previousContainer | Out-Null
      $previous = Join-Path $previousContainer "runtime"
      Move-RuntimeDirectory $targetDir $previous
    }
    if (Test-Path -LiteralPath $targetDir) { throw "A runtime appeared during publication; refusing to overwrite it." }
    Move-RuntimeDirectory $staging $targetDir
    if ($previousContainer) {
      try { Remove-Item -LiteralPath $previousContainer -Recurse -Force -ErrorAction Stop }
      catch { Write-Warning "Runtime published; previous backup could not be fully removed: $previousContainer" }
    }
  } catch {
    $publicationError = $_
    $retain = $false
    if ($previous -and (Test-Path -LiteralPath $previous)) {
      try {
        if (Test-Path -LiteralPath $targetDir) { throw "Destination is occupied." }
        Move-RuntimeDirectory $previous $targetDir
      } catch {
        [Console]::Error.WriteLine("Could not restore runtime. Previous copy: $previous; validated replacement: $staging")
        $retain = $true
      }
    }
    if ($validated -and -not (Test-Path -LiteralPath $targetDir)) {
      [Console]::Error.WriteLine("Validated runtime retained at $staging; retry installation or recover it manually.")
      $retain = $true
    }
    if (-not $retain) {
      if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
      if ($previousContainer -and (Test-Path -LiteralPath $previousContainer)) { Remove-Item -LiteralPath $previousContainer -Recurse -Force }
    }
    throw $publicationError
  }
}

Step "Setting up the shuv2code command..."
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir "shuv2code.cmd"
# UTF-8 without a BOM: cmd.exe reads the shim as-is, and ASCII would corrupt
# non-ASCII characters in the user's home path.
[System.IO.File]::WriteAllText($shim, "@echo off`r`n`"$(Join-Path $targetDir 't3.exe')`" %*", (New-Object System.Text.UTF8Encoding $false))
if ($interactive) { [Console]::Error.Write("`r$esc[2K") }
[Console]::Error.WriteLine("  ${green}Installed shuv2code $version$reset`n")
if (($env:PATH -split ";") -notcontains $binDir) {
  Write-Host "  Add $binDir to your PATH, then run ${bold}shuv2code$reset.`n"
} else {
  Write-Host "  Run ${bold}shuv2code$reset to get started.`n"
}
