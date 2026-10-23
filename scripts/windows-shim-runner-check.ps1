# Runs the Windows installer's command shims on the local cmd.exe and Windows
# PowerShell. Linux pwsh cannot stand in for this: it never parses the .cmd
# bodies. The install root is named "installer home" / "installer bin" so the
# path contains a space, matching the CLI archive smoke test.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:Failures = 0
$script:LogPath = Join-Path (Get-Location) "shim-check.log"
if (Test-Path -LiteralPath $script:LogPath) { Remove-Item -LiteralPath $script:LogPath -Force }
$script:Utf8 = New-Object System.Text.UTF8Encoding $false
$script:Version = "0.0.0-nightly.1"
$script:SystemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { $env:WINDIR }
$script:Cmd = Join-Path $script:SystemRoot "System32\cmd.exe"
$script:PowerShell51 = Join-Path $script:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

function Write-Log([string] $Message) {
  Write-Host $Message
  [IO.File]::AppendAllText($script:LogPath, $Message + "`r`n", $script:Utf8)
}

function Show-TextFile([string] $Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $text = $script:Utf8.GetString($bytes)
  $visible = $text.Replace("`r", "<CR>").Replace("`n", "<LF>`n")
  Write-Log "FILE $Path ($($bytes.Length) bytes)"
  Write-Log $visible
}

function ConvertTo-ResultText($Result) {
  $argsJson = ConvertTo-Json -InputObject @($Result.Arguments) -Compress
  $stdout = ConvertTo-Json -InputObject ([string] $Result.Stdout) -Compress
  $stderr = ConvertTo-Json -InputObject ([string] $Result.Stderr) -Compress
  $stub = "<missing>"
  if ($Result.StubLog -and (Test-Path -LiteralPath $Result.StubLog)) {
    $stub = ConvertTo-Json -InputObject ([IO.File]::ReadAllText($Result.StubLog)) -Compress
  }
  $note = if ($Result.Note) { $Result.Note } else { "" }
  return @(
    "exit: $($Result.ExitCode)",
    "command: $($Result.File)",
    "args: $argsJson",
    "stdout: $stdout",
    "stderr: $stderr",
    "stub: $stub",
    "note: $note"
  ) -join "`n"
}

function Get-SmokeEnvironment([string] $StubLog) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "ARM64" } else { "AMD64" }
  return @{
    PATH                     = ""
    HOME                     = $script:Root
    USERPROFILE              = $script:Root
    TMPDIR                   = $script:Root
    TEMP                     = $script:Root
    SystemRoot               = $script:SystemRoot
    WINDIR                   = $script:SystemRoot
    ComSpec                  = $script:Cmd
    PROCESSOR_ARCHITECTURE   = $arch
    S2CODE_HOME              = $script:InstallHome
    S2CODE_VERSION           = $script:Version
    S2CODE_INSTALL_BIN_DIR   = $script:BinDir
    S2CODE_RELEASE_BASE_URL  = "http://127.0.0.1:1"
    S2CODE_STUB_LOG          = $StubLog
  }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory)][string] $File,
    [string[]] $Arguments = @(),
    [switch] $SmokeEnvironment,
    [string] $Note = ""
  )
  $stubLog = Join-Path $script:Root ("stub-" + [guid]::NewGuid().ToString("n") + ".log")
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $File
  $psi.WorkingDirectory = $script:Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = $script:Utf8
  $psi.StandardErrorEncoding = $script:Utf8
  foreach ($arg in $Arguments) { [void] $psi.ArgumentList.Add($arg) }
  if ($SmokeEnvironment) {
    $psi.Environment.Clear()
    $envMap = Get-SmokeEnvironment $stubLog
    foreach ($key in $envMap.Keys) { $psi.Environment[$key] = [string] $envMap[$key] }
  } else {
    $psi.Environment["S2CODE_STUB_LOG"] = $stubLog
    $psi.Environment["S2CODE_HOME"] = $script:InstallHome
    $psi.Environment["S2CODE_VERSION"] = $script:Version
    $psi.Environment["S2CODE_INSTALL_BIN_DIR"] = $script:BinDir
    $psi.Environment["S2CODE_RELEASE_BASE_URL"] = "http://127.0.0.1:1"
  }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $psi
  [void] $process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(60000)) {
    try { $process.Kill($true) } catch { }
    throw "timed out after 60s: $File $([string]::Join(' ', $Arguments))"
  }
  # Honor the redirected-stream flush after the process handle signals.
  $process.WaitForExit()
  return [pscustomobject]@{
    ExitCode  = $process.ExitCode
    Stdout    = $stdoutTask.GetAwaiter().GetResult()
    Stderr    = $stderrTask.GetAwaiter().GetResult()
    File      = $File
    Arguments = @($Arguments)
    StubLog   = $stubLog
    Note      = $Note
  }
}

function Assert-SameResult([string] $Label, $Actual, $Expected) {
  $sameExit = $Actual.ExitCode -eq $Expected.ExitCode
  $sameOut = $Actual.Stdout -eq $Expected.Stdout
  $sameErr = $Actual.Stderr -eq $Expected.Stderr
  if ($sameExit -and $sameOut -and $sameErr) {
    Write-Log "PASS $Label exit=$($Actual.ExitCode)"
    return
  }
  $script:Failures++
  Write-Log "FAIL $Label"
  Write-Log "ACTUAL"
  Write-Log (ConvertTo-ResultText $Actual)
  Write-Log "EXPECTED"
  Write-Log (ConvertTo-ResultText $Expected)
}

function Write-CmdDriver([string] $Path, [string] $Line) {
  [IO.File]::WriteAllText($Path, "@echo off`r`n$Line`r`n", $script:Utf8)
}

function Invoke-Install([string] $Label) {
  $result = Invoke-Captured -File $script:PowerShell51 -Arguments @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $script:InstallScript
  ) -SmokeEnvironment -Note "install.ps1 $Label"
  Write-Log "INSTALL $Label exit=$($result.ExitCode)"
  if ($result.Stdout) { Write-Log "install stdout: $(ConvertTo-Json $result.Stdout -Compress)" }
  if ($result.Stderr) { Write-Log "install stderr: $(ConvertTo-Json $result.Stderr -Compress)" }
  if ($result.ExitCode -ne 0) {
    $script:Failures++
    Write-Log "FAIL $Label install.ps1"
    return $false
  }
  return $true
}

function Get-HistoricalForFShim([string] $LegacyCommand) {
  # The body shipped by #324. Upgrades still have to recognize it.
  $lines = @(
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "s2_line="',
    "for /f `"usebackq skip=1 delims=`" %%L in (`"$LegacyCommand`") do set `"s2_line=%%L`"",
    'if not defined s2_line exit /b 1',
    'set "s2_exe=%s2_line:~1,-4%"',
    'if not defined s2_exe exit /b 1',
    'endlocal & "%s2_exe%" %*',
    'exit /b %ERRORLEVEL%'
  )
  return ($lines -join "`r`n")
}

function Write-NodeForwarder([string] $LegacyCommand, [string] $Output) {
  $runner = Join-Path $PSScriptRoot "_print-windows-forwarder.ts"
  [IO.File]::WriteAllText($runner, @'
import * as fs from "node:fs";
import { windowsForwarderShim } from "../apps/server/src/cli/windowsForwarderShim.ts";

const legacy = process.argv[2];
const output = process.argv[3];
if (!legacy || !output) {
  process.stderr.write("missing arguments\n");
  process.exit(2);
}
fs.writeFileSync(output, windowsForwarderShim(legacy));
'@, $script:Utf8)
  try {
    $result = Invoke-Captured -File "node" -Arguments @(
      "--experimental-strip-types", $runner, $LegacyCommand, $Output
    ) -Note "print windowsForwarderShim"
    if ($result.ExitCode -ne 0) {
      Write-Log (ConvertTo-ResultText $result)
      throw "windowsForwarderShim printer exited $($result.ExitCode)"
    }
  } finally {
    if (Test-Path -LiteralPath $runner) { Remove-Item -LiteralPath $runner -Force }
  }
}

function Assert-ForwarderMatchesNode([string] $Label) {
  $expected = Join-Path $script:Root "expected-forwarder.cmd"
  Write-NodeForwarder $script:LegacyCommand $expected
  $actualBytes = [IO.File]::ReadAllBytes($script:CanonicalCommand)
  $expectedBytes = [IO.File]::ReadAllBytes($expected)
  $same = $actualBytes.Length -eq $expectedBytes.Length
  if ($same) {
    for ($i = 0; $i -lt $actualBytes.Length; $i++) {
      if ($actualBytes[$i] -ne $expectedBytes[$i]) { $same = $false; break }
    }
  }
  if ($same) {
    Write-Log "PASS $Label forwarder bytes match windowsForwarderShim"
    return
  }
  $script:Failures++
  Write-Log "FAIL $Label forwarder bytes differ from windowsForwarderShim"
  Show-TextFile $script:CanonicalCommand
  Show-TextFile $expected
}

function Invoke-Behavior([string] $Label, [string] $Executable) {
  $contexts = @(
    @{ Name = "smoke-env"; Smoke = $true },
    @{ Name = "user-env"; Smoke = $false }
  )
  foreach ($context in $contexts) {
    $smoke = [bool] $context.Smoke
    $prefix = "$Label $($context.Name)"
    foreach ($pair in @(
        @{ Name = "version"; Args = "--version"; Special = $false },
        @{ Name = "bad-option"; Args = "--not-a-real-option"; Special = $false },
        @{ Name = "percent-caret"; Args = $null; Special = $true }
      )) {
      $directArgs = if ($pair.Special) { @("%OS%", "a^b") } else { @([string] $pair.Args) }
      if ($smoke) {
        $direct = Invoke-Captured -File $Executable -Arguments $directArgs -SmokeEnvironment -Note "direct $($pair.Name)"
      } else {
        $direct = Invoke-Captured -File $Executable -Arguments $directArgs -Note "direct $($pair.Name)"
      }
      if ($pair.Name -eq "bad-option" -and $direct.ExitCode -eq 0) {
        $script:Failures++
        Write-Log "FAIL $prefix direct bad-option exited 0"
        Write-Log (ConvertTo-ResultText $direct)
      }

      $psArgText = if ($pair.Special) { "--probe '%OS%' 'a^b'" } else { [string] $pair.Args }
      $quotedExe = "'" + $Executable.Replace("'", "''") + "'"
      $directCommand = "& $quotedExe $psArgText; exit `$LASTEXITCODE"
      $shimCommand = "& (Join-Path `$env:S2CODE_INSTALL_BIN_DIR '$($script:CanonicalName)') $psArgText; exit `$LASTEXITCODE"
      $legacyCommandText = "& (Join-Path `$env:S2CODE_INSTALL_BIN_DIR '$($script:LegacyName)') $psArgText; exit `$LASTEXITCODE"
      foreach ($shellCase in @(
          @{ Name = "canonical"; Command = $shimCommand },
          @{ Name = "legacy"; Command = $legacyCommandText }
        )) {
        $params = @{
          File      = $script:PowerShell51
          Arguments = @("-NoProfile", "-NonInteractive", "-Command", [string] $shellCase.Command)
          Note      = "powershell $($shellCase.Command)"
        }
        if ($smoke) { $params.SmokeEnvironment = $true }
        $actual = Invoke-Captured @params
        $expectedParams = @{
          File      = $script:PowerShell51
          Arguments = @("-NoProfile", "-NonInteractive", "-Command", $directCommand)
          Note      = "powershell direct $directCommand"
        }
        if ($smoke) { $expectedParams.SmokeEnvironment = $true }
        $expected = Invoke-Captured @expectedParams
        Assert-SameResult "$prefix powershell $($shellCase.Name) $($pair.Name)" $actual $expected
        if ($pair.Name -eq "bad-option" -and $actual.ExitCode -eq 0) {
          $script:Failures++
          Write-Log "FAIL $prefix powershell $($shellCase.Name) bad-option exited 0"
        }
      }

      $driverDir = Join-Path $script:Root "drivers"
      New-Item -ItemType Directory -Force -Path $driverDir | Out-Null
      # One cmd parse turns %%OS%% into a literal %OS%. A second parse would expand it.
      $driverArg = if ($pair.Special) { '--probe "%%OS%%" "a^b"' } else { [string] $pair.Args }
      $directDriver = Join-Path $driverDir "direct-$($context.Name)-$($pair.Name).cmd"
      $canonicalDriver = Join-Path $driverDir "canonical-$($context.Name)-$($pair.Name).cmd"
      $legacyDriver = Join-Path $driverDir "legacy-$($context.Name)-$($pair.Name).cmd"
      Write-CmdDriver $directDriver "`"$Executable`" $driverArg"
      Write-CmdDriver $canonicalDriver "`"$($script:CanonicalCommand)`" $driverArg"
      Write-CmdDriver $legacyDriver "`"$($script:LegacyCommand)`" $driverArg"
      foreach ($shellCase in @(
          @{ Name = "canonical"; Driver = $canonicalDriver },
          @{ Name = "legacy"; Driver = $legacyDriver }
        )) {
        $params = @{
          File      = $script:Cmd
          Arguments = @("/d", "/c", [string] $shellCase.Driver)
          Note      = "cmd driver $([IO.File]::ReadAllText([string] $shellCase.Driver))"
        }
        if ($smoke) { $params.SmokeEnvironment = $true }
        $actual = Invoke-Captured @params
        $expectedParams = @{
          File      = $script:Cmd
          Arguments = @("/d", "/c", $directDriver)
          Note      = "cmd direct driver $([IO.File]::ReadAllText($directDriver))"
        }
        if ($smoke) { $expectedParams.SmokeEnvironment = $true }
        $expected = Invoke-Captured @expectedParams
        Assert-SameResult "$prefix cmd $($shellCase.Name) $($pair.Name)" $actual $expected
        if ($pair.Name -eq "bad-option" -and $actual.ExitCode -eq 0) {
          $script:Failures++
          Write-Log "FAIL $prefix cmd $($shellCase.Name) bad-option exited 0"
        }
      }
    }
  }
}

function Invoke-EchoTrace {
  $trace = Join-Path $script:Root "traced-canonical.cmd"
  $body = [IO.File]::ReadAllText($script:CanonicalCommand)
  $body = $body.Replace("@echo off", "@echo on")
  if ($body.Contains("endlocal &")) {
    $body = $body.Replace(
      "endlocal &",
      "echo TRACE s2_line=[%s2_line%]`r`necho TRACE s2_exe=[%s2_exe%]`r`nendlocal &"
    )
  }
  [IO.File]::WriteAllText($trace, $body, $script:Utf8)
  $driver = Join-Path $script:Root "trace-driver.cmd"
  Write-CmdDriver $driver "`"$trace`" --version"
  $result = Invoke-Captured -File $script:Cmd -Arguments @("/d", "/c", $driver) -SmokeEnvironment -Note "echo-on canonical trace"
  Write-Log "ECHO TRACE exit=$($result.ExitCode)"
  Write-Log "ECHO TRACE stdout:"
  Write-Log $result.Stdout
  Write-Log "ECHO TRACE stderr:"
  Write-Log $result.Stderr
  Show-TextFile $trace
}

$rootName = "s2shim-" + [guid]::NewGuid().ToString("n")
$script:Root = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP $rootName))
$script:InstallHome = [IO.Path]::GetFullPath((Join-Path $script:Root "installer home"))
$script:BinDir = [IO.Path]::GetFullPath((Join-Path $script:Root "installer bin"))
$script:Cache = [IO.Path]::GetFullPath((Join-Path $script:InstallHome "runtime\versions\$($script:Version)"))
$script:Exe = [IO.Path]::GetFullPath((Join-Path $script:Cache "t3.exe"))
$script:UpdatedExe = [IO.Path]::GetFullPath((Join-Path $script:Cache "t3-updated.exe"))
$script:CanonicalName = "s2code-nightly.cmd"
$script:LegacyName = "shuv2code-nightly.cmd"
$script:CanonicalCommand = [IO.Path]::Combine($script:BinDir, $script:CanonicalName)
$script:LegacyCommand = [IO.Path]::Combine($script:BinDir, $script:LegacyName)
$script:InstallScript = Join-Path $PSScriptRoot "install.ps1"
New-Item -ItemType Directory -Force -Path $script:Root | Out-Null

Write-Log "runner=$env:RUNNER_NAME os=$([Environment]::OSVersion.VersionString) arch=$env:PROCESSOR_ARCHITECTURE"
Write-Log "root=$($script:Root)"
$ver = Invoke-Captured -File $script:Cmd -Arguments @("/d", "/c", "ver") -Note "cmd ver"
Write-Log "cmd ver exit=$($ver.ExitCode) stdout=$($ver.Stdout.Trim()) stderr=$($ver.Stderr.Trim())"
$smokeCmd = Invoke-Captured -File $script:Cmd -Arguments @("/d", "/c", "echo smoke-env-ok") -SmokeEnvironment -Note "cmd with smoke env"
Write-Log "smoke-env cmd exit=$($smokeCmd.ExitCode) stdout=$($smokeCmd.Stdout.Trim()) stderr=$($smokeCmd.Stderr.Trim())"

$build = Join-Path $script:Root "stub-build"
New-Item -ItemType Directory -Force -Path $build, $script:Cache, $script:BinDir | Out-Null
$stubCs = Join-Path $build "stub.cs"
[IO.File]::WriteAllText($stubCs, @'
using System;
using System.IO;
using System.Text;

public class Stub {
  public static int Main(string[] args) {
    var builder = new StringBuilder();
    builder.Append("exe=").Append(typeof(Stub).Assembly.Location).Append('\n');
    builder.Append("count=").Append(args.Length.ToString()).Append('\n');
    for (int i = 0; i < args.Length; i++) {
      builder.Append("arg").Append(i.ToString()).Append('=');
      builder.Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i])));
      builder.Append('\n');
    }
    Console.Out.Write(builder.ToString());
    string log = Environment.GetEnvironmentVariable("S2CODE_STUB_LOG");
    if (!string.IsNullOrEmpty(log)) File.WriteAllText(log, builder.ToString(), new UTF8Encoding(false));
    if (args.Length == 1 && args[0] == "--version") return 0;
    if (args.Length >= 1 && args[0] == "--not-a-real-option") {
      Console.Error.WriteLine("unknown option");
      return 2;
    }
    return 0;
  }
}
'@, $script:Utf8)
$built = Join-Path $build "t3.exe"
$csc = @(
  (Join-Path $script:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $script:SystemRoot "Microsoft.NET\Framework\v4.0.30319\csc.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
  $found = Get-ChildItem -Path (Join-Path $script:SystemRoot "Microsoft.NET") -Filter csc.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($found) { $csc = $found.FullName }
}
if (-not $csc) { throw "csc.exe was not found under $script:SystemRoot\Microsoft.NET" }
Write-Log "csc=$csc"
$compile = Invoke-Captured -File $csc -Arguments @("/nologo", "/target:exe", "/out:$built", $stubCs) -Note "csc"
if ($compile.ExitCode -ne 0) {
  Write-Log (ConvertTo-ResultText $compile)
  throw "csc failed"
}
Copy-Item -LiteralPath $built -Destination $script:Exe -Force
[IO.File]::WriteAllText((Join-Path $script:InstallHome ".product-identity"), "s2code`n", $script:Utf8)
[IO.File]::WriteAllText((Join-Path $script:Cache ".install-product"), "s2code`n", $script:Utf8)
[IO.File]::WriteAllText((Join-Path $script:Cache ".install-complete"), "$($script:Version)`n", $script:Utf8)

$stubRun = Invoke-Captured -File $script:Exe -Arguments @("--version") -SmokeEnvironment -Note "stub --version"
if ($stubRun.ExitCode -ne 0 -or $stubRun.Stdout -notmatch "arg0=") {
  Write-Log (ConvertTo-ResultText $stubRun)
  throw "stub t3.exe did not run"
}
Write-Log "PASS stub --version"

if (-not (Invoke-Install "fresh")) { exit 1 }
Show-TextFile $script:CanonicalCommand
Show-TextFile $script:LegacyCommand
Invoke-EchoTrace
Assert-ForwarderMatchesNode "fresh"
Invoke-Behavior "fresh" $script:Exe

Copy-Item -LiteralPath $script:Exe -Destination $script:UpdatedExe -Force
[IO.File]::WriteAllText($script:LegacyCommand, "@echo off`r`n`"$($script:UpdatedExe)`" %*", $script:Utf8)
Write-Log "FOLLOW old updater repointed legacy only"
Show-TextFile $script:LegacyCommand
Invoke-Behavior "follow-old-updater" $script:UpdatedExe

$upgradeBodies = @(
  @{ Name = "quote-legacy"; Body = "@echo off`r`n`"$($script:LegacyCommand)`" %*" },
  @{ Name = "call-legacy"; Body = "@echo off`r`ncall `"$($script:LegacyCommand)`" %*" },
  @{ Name = "for-f-handoff"; Body = (Get-HistoricalForFShim $script:LegacyCommand) },
  @{ Name = "direct-canonical"; Body = "@echo off`r`n`"$($script:Exe)`" %*" }
)
foreach ($upgrade in $upgradeBodies) {
  Write-Log "UPGRADE from $($upgrade.Name)"
  [IO.File]::WriteAllText($script:CanonicalCommand, [string] $upgrade.Body, $script:Utf8)
  [IO.File]::WriteAllText($script:LegacyCommand, "@echo off`r`n`"$($script:Exe)`" %*", $script:Utf8)
  if (-not (Invoke-Install "upgrade-$($upgrade.Name)")) { continue }
  Assert-ForwarderMatchesNode "upgrade-$($upgrade.Name)"
  $legacyText = [IO.File]::ReadAllText($script:LegacyCommand)
  $expectedLegacy = "@echo off`r`n`"$($script:Exe)`" %*"
  if ($legacyText -ne $expectedLegacy) {
    $script:Failures++
    Write-Log "FAIL upgrade-$($upgrade.Name) legacy shim was rewritten unexpectedly"
    Show-TextFile $script:LegacyCommand
  } else {
    Write-Log "PASS upgrade-$($upgrade.Name) legacy shim stayed a direct exe launcher"
  }
  Invoke-Behavior "upgrade-$($upgrade.Name)" $script:Exe
}

if ($script:Failures -gt 0) {
  Write-Log "FAILED $($script:Failures) check(s)"
  Write-Host "::error title=Windows shim check::$($script:Failures) check(s) failed. See shim-check.log."
  exit 1
}
Write-Log "ALL WINDOWS SHIM CHECKS PASSED"
exit 0
