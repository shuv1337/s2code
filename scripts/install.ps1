# Installs the S2Code CLI from a GitHub Release archive on Windows. Needs
# only PowerShell 5.1+; no Node, npm, or compiler.
#
#   irm https://raw.githubusercontent.com/shuv1337/shuv2code/main/scripts/install.ps1 | iex
#
# Environment:
#   S2CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: nightly, the only train the fork publishes)
#   S2CODE_VERSION           exact version to install (overrides S2CODE_CHANNEL)
#   S2CODE_HOME              Server home directory (default: ~\.s2code-v2-<channel>,
#                            or ~\.s2code-v2 for stable)
#   S2CODE_INSTALL_BIN_DIR   where s2code is linked (default: ~\.local\bin)
#   S2CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $S2CODE_HOME\runtime\versions\<version>, the
# same layout `s2code service install` uses, so the service reuses this download.
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Environment lookups are case-insensitive on Windows. New nonblank names win.
foreach ($key in @("HOME", "CHANNEL", "VERSION", "INSTALL_BIN_DIR", "RELEASE_BASE_URL", "IMPORT_UPSTREAM")) {
  $canonical = [Environment]::GetEnvironmentVariable("S2CODE_$key")
  if ([string]::IsNullOrWhiteSpace($canonical)) {
    $canonical = [Environment]::GetEnvironmentVariable("SHUV2CODE_$key")
  }
  [Environment]::SetEnvironmentVariable("S2CODE_$key", $(if ($canonical) { $canonical.Trim() } else { $null }))
}
# Retain the current published repository until its external cutover is verified.
$repo = "shuv1337/shuv2code"
$baseUrl = if ($env:S2CODE_RELEASE_BASE_URL) { $env:S2CODE_RELEASE_BASE_URL.TrimEnd("/") } else { "https://github.com/$repo/releases/download" }
$t3Home = if ($env:S2CODE_HOME) { $env:S2CODE_HOME } else { Join-Path $HOME ".s2code-v2" }
$binDir = if ($env:S2CODE_INSTALL_BIN_DIR) { $env:S2CODE_INSTALL_BIN_DIR } else { Join-Path $HOME ".local\bin" }
if ($env:T3CODE_HOME -and -not $env:S2CODE_HOME) {
  [Console]::Error.WriteLine("s2code: ignoring T3CODE_HOME; use S2CODE_HOME to configure the fork's home.")
}

function Fail([string] $message) {
  Write-Error "s2code install: $message"
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

if ($env:S2CODE_IMPORT_UPSTREAM) { Fail "Upstream import is not supported; choose a separate S2CODE_HOME." }
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
    $label = if ($i -eq 1) { "     ${bold}s2code$reset" } elseif ($i -eq 2) { "     ${muted}CLI installer$reset" } else { "" }
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

$channel = if ($env:S2CODE_CHANNEL) { $env:S2CODE_CHANNEL } else { "nightly" }
$version = $env:S2CODE_VERSION
if (-not $version) {
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  $tagPattern = switch ($channel) {
    "stable" { '^v\d+\.\d+\.\d+$' }
    "nightly" { '^v\d+\.\d+\.\d+-nightly\.\d+\.\d+$' }
    "preview" { '^v\d+\.\d+\.\d+-preview\.\d+\.\d+$' }
    default { Fail "S2CODE_CHANNEL must be stable, nightly, or preview" }
  }
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers @{ "User-Agent" = "t3-install" }
  $tag = ($releases | Where-Object { -not $_.draft -and $_.tag_name -match $tagPattern } | Select-Object -First 1).tag_name
  if (-not $tag) { Fail "could not find a $channel release; set S2CODE_VERSION" }
  $version = $tag.Substring(1)
}
if ($version -match '-preview\.') {
  Write-Warning "s2code $version is a preview build. Preview builds are cut by maintainers from unreleased branches to exercise the release pipeline. They can be broken, receive no fixes, and are never offered as updates. Set S2CODE_CHANNEL=nightly (the default) for a supported build."
  if ($channel -ne "preview" -and -not $env:S2CODE_VERSION) {
    Fail "refusing a preview build that was not explicitly requested"
  }
}

$stem = "s2code-$version-win32-$arch"
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') { Fail "Invalid release version." }
$archive = "$stem.zip"
$previousStem = "shuv2code-$version-win32-$arch"
$previousArchive = "$previousStem.zip"
$legacyStem = "t3-$version-win32-$arch"
$legacyArchive = "$legacyStem.zip"
$commandName = if ($version -match '^[^-+]+-nightly\.') { "s2code-nightly" } elseif ($version -match '^[^-+]+-(preview|pr)\.') { "s2code-preview" } else { "s2code" }
if (-not $env:S2CODE_HOME) {
  if ($version -match '^[^-+]+-nightly\.') { $t3Home = Join-Path $HOME ".s2code-v2-nightly" }
  elseif ($version -match '^[^-+]+-(preview|pr)\.') { $t3Home = Join-Path $HOME ".s2code-v2-preview" }
  $legacyHome = Join-Path $HOME (".shuv2code-v2" + $commandName.Substring("s2code".Length))
  if ((Test-Path -LiteralPath $legacyHome) -and @(Get-ChildItem -LiteralPath $legacyHome -Force | Where-Object { $_.Name -ne '.product-identity' }).Count -gt 0) {
    if ((Test-Path -LiteralPath $t3Home) -and @(Get-ChildItem -LiteralPath $t3Home -Force | Where-Object { $_.Name -ne '.product-identity' }).Count -gt 0) {
      Fail "Both S2Code homes contain state. Choose S2CODE_HOME explicitly; they will not be merged."
    }
    $legacyMarker = Join-Path $legacyHome ".product-identity"
    Assert-ProductPath $legacyMarker
    if (-not (Test-Path -LiteralPath $legacyMarker -PathType Leaf)) { Fail "Cannot establish product ownership of the legacy home. Verify it offline and choose S2CODE_HOME explicitly." }
    if ([IO.File]::ReadAllText($legacyMarker).Trim() -cnotin @("s2code", "shuv2code")) { Fail "Cannot establish product ownership of the legacy home. Verify it offline and choose S2CODE_HOME explicitly." }
    $t3Home = $legacyHome
  }
}
$t3Home = [IO.Path]::GetFullPath($t3Home)
Assert-ProductPath $t3Home
if ($t3Home -match '(^|[\\/])\.t3([\\/]|$)') { Fail "Refusing an upstream .t3 home; choose a separate S2CODE_HOME." }
$defaultForkHome = [IO.Path]::GetFullPath((Join-Path $HOME ".shuv2code-v2"))
$homeMarker = Join-Path $t3Home ".product-identity"
Assert-ProductPath $homeMarker
if (Test-Path -LiteralPath $homeMarker) {
  $homeProduct = [IO.File]::ReadAllText($homeMarker).Trim()
  if (-not "s2code".StartsWith($homeProduct, [StringComparison]::Ordinal) -and -not "shuv2code".StartsWith($homeProduct, [StringComparison]::Ordinal)) { Fail "Home belongs to another product." }
} else { $homeProduct = "" }
if ($homeProduct -cnotin @("s2code", "shuv2code") -and (Test-Path -LiteralPath $t3Home) -and @(Get-ChildItem -LiteralPath $t3Home -Force | Where-Object { $_.Name -ne '.product-identity' }).Count -gt 0 -and -not [string]::Equals($t3Home, $defaultForkHome, [StringComparison]::OrdinalIgnoreCase)) {
  Fail "Cannot establish product ownership. Choose an empty S2CODE_HOME; verify old custom fork homes offline before adding .product-identity containing s2code."
}
foreach ($child in @("userdata", "dev", "runtime")) { Assert-ProductPath (Join-Path $t3Home $child) }
$binDir = [IO.Path]::GetFullPath($binDir)
$legacyCommandName = "shuv2code" + $commandName.Substring("s2code".Length)
$legacyCommand = Join-Path $binDir "$legacyCommandName.cmd"
# cmd.exe does not chain to a quoted .cmd. Without call, a bin path that
# contains a space never starts the legacy launcher, and s2code exits with no output.
$canonicalForwarder = "@echo off`r`ncall `"$legacyCommand`" %*"
$commandNames = @($commandName, $legacyCommandName)
foreach ($name in $commandNames) {
  $existingCommand = Join-Path $binDir "$name.cmd"
  if (Test-Path -LiteralPath $existingCommand) {
    Assert-ProductPath $existingCommand
    $content = [IO.File]::ReadAllText($existingCommand)
    if ($name -eq $commandName -and $content -eq $canonicalForwarder) {
      Assert-ProductPath $legacyCommand
      if (-not (Test-Path -LiteralPath $legacyCommand -PathType Leaf)) { Fail "Refusing a canonical command without an owned legacy launcher: $existingCommand" }
      $content = [IO.File]::ReadAllText($legacyCommand)
    }
    $ownedPattern = '^@echo off\r?\n"' + [regex]::Escape((Join-Path $t3Home 'runtime/versions')) + '[\\/][^\\/\r\n]+[\\/]t3\.exe" %\*\s*$'
    if ($content -notmatch $ownedPattern) { Fail "Refusing to replace a command owned by another installation: $existingCommand" }
  }
}
New-Item -ItemType Directory -Force -Path $t3Home | Out-Null
$homeMarkerTemp = Join-Path $t3Home (".product-identity." + [Guid]::NewGuid().ToString() + ".tmp")
try {
  if ($homeProduct -cnotin @("shuv2code", "s2code")) {
    $homeProduct = if ([string]::Equals($t3Home, $defaultForkHome, [StringComparison]::OrdinalIgnoreCase)) { "shuv2code" } else { "s2code" }
  }
  Set-Content -LiteralPath $homeMarkerTemp -Value $homeProduct
  if (Test-Path -LiteralPath $homeMarker) { [IO.File]::Replace($homeMarkerTemp, $homeMarker, "$homeMarkerTemp.previous") }
  else { [IO.File]::Move($homeMarkerTemp, $homeMarker) }
} finally {
  foreach ($temporary in @($homeMarkerTemp, "$homeMarkerTemp.previous")) {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}
# The release records its own signing policy. A release without one, or an
# unreadable one, is not an installation failure; the warning is simply skipped.
# Release assets are served as application/octet-stream, so the body arrives as
# text or bytes and is decoded here rather than by the web cmdlet.
try {
  $releaseBody = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/v$version/release.json" -Headers @{ "User-Agent" = "t3-install" }).Content
  if ($releaseBody -is [byte[]]) { $releaseBody = [Text.Encoding]::UTF8.GetString($releaseBody) }
  $releaseMetadata = [string]$releaseBody | ConvertFrom-Json
  if ($releaseMetadata.signing.unsigned) {
    Write-Warning "s2code $version is an UNSIGNED build. At least one platform was built without signing credentials, so its code signature and notarization are absent and your system may refuse to run it without an override."
  }
} catch {}

$versionsDir = Join-Path $t3Home "runtime\versions"
$targetDir = Join-Path $versionsDir $version
$marker = Join-Path $targetDir ".install-complete"
Assert-ProductPath $targetDir
Assert-ProductPath (Join-Path $targetDir "t3.exe")
Assert-ProductPath $marker
$productMarker = Join-Path $targetDir ".install-product"
Assert-ProductPath $productMarker
$product = if (Test-Path -LiteralPath $productMarker) { [IO.File]::ReadAllText($productMarker).Trim() } else { "" }
if (-not "s2code".StartsWith($product, [StringComparison]::Ordinal) -and -not "shuv2code".StartsWith($product, [StringComparison]::Ordinal)) { Fail "Refusing to reuse or replace a foreign runtime cache." }
$completion = $version
$installedMarker = if (Test-Path -LiteralPath $marker) { [IO.File]::ReadAllText($marker).Trim().Replace("`r`n", "`n") } else { "" }

if ((Test-Path (Join-Path $targetDir "t3.exe")) -and $product -cin @("s2code", "shuv2code") -and $installedMarker -eq $completion) {
  Step "Version $version is already downloaded."
} else {
  New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
  $staging = Join-Path $versionsDir (".staging-" + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $staging | Out-Null
  $previous = $previousContainer = $null
  $validated = $false
  try {
    if ($interactive) { [Console]::Error.Write("`r$esc[2K") }
    [Console]::Error.WriteLine("  ${muted}Installing$reset s2code $bold$version$reset`n")
    Step "Downloading..."
    try {
      Fetch "$baseUrl/v$version/SHA256SUMS" (Join-Path $staging "SHA256SUMS")
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 404) {
        Fail "s2code $version has no release archive for win32-$arch"
      }
      throw
    }
    $expected = (Get-Content (Join-Path $staging "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1)
    if (-not $expected) {
      if ($homeProduct -cne "shuv2code") { Fail "This release predates the S2Code transition. A fresh S2Code home requires the first bridge release; existing verified shuv2code homes can still install it." }
      $stem = $previousStem
      $archive = $previousArchive
      $expected = (Get-Content (Join-Path $staging "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1)
    }
    if (-not $expected) {
      $stem = $legacyStem
      $archive = $legacyArchive
      $expected = (Get-Content (Join-Path $staging "SHA256SUMS") | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1)
    }
    if (-not $expected) { Fail "no release archive for win32-$arch is listed in SHA256SUMS" }
    Fetch "$baseUrl/v$version/$archive" (Join-Path $staging $archive) -progress

    Step "Verifying the download..."

    $expected = ($expected -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $staging $archive)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { Fail "checksum mismatch for $archive" }

    Step "Extracting s2code..."
    # The archive module reads the global preference, not the caller's local scope.
    $savedProgress = $global:ProgressPreference
    try {
      $global:ProgressPreference = "SilentlyContinue"
      Expand-Archive -Path (Join-Path $staging $archive) -DestinationPath $staging -Force
    } finally { $global:ProgressPreference = $savedProgress }
    # Byte-identical download aliases retain the older root for installed launchers.
    $roots = @(@("s2code-$version-win32-$arch", $previousStem, $legacyStem) | Where-Object { Test-Path -LiteralPath (Join-Path $staging $_) -PathType Container })
    if (@($roots).Count -ne 1) { Fail "The CLI archive must contain exactly one recognized runtime root." }
    $runtimeRoot = Join-Path $staging $roots[0]
    Get-ChildItem $runtimeRoot | Move-Item -Destination $staging
    Remove-Item $runtimeRoot, (Join-Path $staging $archive), (Join-Path $staging "SHA256SUMS") -Recurse -Force

    & (Join-Path $staging "t3.exe") --version | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "the downloaded executable does not run" }
    Set-Content -Path (Join-Path $staging ".install-complete") -Value "$completion`n" -NoNewline
    Set-Content -Path (Join-Path $staging ".install-product") -Value "$homeProduct`n" -NoNewline

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

Step "Setting up the s2code command..."
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
# UTF-8 without a BOM: cmd.exe reads the shim as-is, and ASCII would corrupt
# non-ASCII characters in the user's home path.
# Installed old updaters only repoint their legacy command.
[System.IO.File]::WriteAllText($legacyCommand, "@echo off`r`n`"$(Join-Path $targetDir 't3.exe')`" %*", (New-Object System.Text.UTF8Encoding $false))
[System.IO.File]::WriteAllText((Join-Path $binDir "$commandName.cmd"), $canonicalForwarder, (New-Object System.Text.UTF8Encoding $false))
if ($interactive) { [Console]::Error.Write("`r$esc[2K") }
[Console]::Error.WriteLine("  ${green}Installed s2code $version$reset`n")
if (($env:PATH -split ";") -notcontains $binDir) {
  Write-Host "  Add $binDir to your PATH, then run $bold$commandName$reset.`n"
} else {
  Write-Host "  Run $bold$commandName$reset to get started.`n"
}
