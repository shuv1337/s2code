// @effect-diagnostics nodeBuiltinImport:off - Exercises the installed PowerShell archive parser in a disposable tree.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { cliArchiveStem } from "./build-cli-archive.ts";
import { cliArchiveFileName, cliArchivePreviousFileName } from "@t3tools/shared/cliRelease";

const hasPwsh =
  NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

it.skipIf(!hasPwsh)(
  "keeps renamed Windows archives readable by the installed shuv2code parser",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "s2code-archive-bridge-"));
    try {
      const version = "1.2.3";
      const root = cliArchiveStem(version, "win", "x64");
      const canonical = cliArchiveFileName(version, "win32-x64");
      const previous = cliArchivePreviousFileName(version, "win32-x64");
      const source = NodePath.join(directory, "source", root);
      NodeFS.mkdirSync(source, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(source, "t3.exe"), "runtime fixture");
      const script = NodePath.join(directory, "verify.ps1");
      NodeFS.writeFileSync(
        script,
        `
$ErrorActionPreference = 'Stop'
$directory = $env:FIXTURE_DIRECTORY
$archive = Join-Path $directory $env:FIXTURE_CANONICAL
Compress-Archive -LiteralPath (Join-Path $directory ('source/' + $env:FIXTURE_ROOT)) -DestinationPath $archive
$legacyArchive = Join-Path $directory $env:FIXTURE_PREVIOUS
Copy-Item $archive $legacyArchive
$staging = Join-Path $directory 'extracted'
Expand-Archive -Path $legacyArchive -DestinationPath $staging -Force
# The shipped installer derives this root from its shuv2code download name.
$stem = $env:FIXTURE_PREVIOUS -replace '\\.zip$', ''
Get-ChildItem (Join-Path $staging $stem) | Move-Item -Destination $staging
Remove-Item (Join-Path $staging $stem) -Recurse -Force
`,
      );
      const result = NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-File", script], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          ...Object.fromEntries(
            ["SystemRoot", "TMPDIR", "TEMP", "TMP"]
              .filter((key) => process.env[key])
              .map((key) => [key, process.env[key]]),
          ),
          FIXTURE_DIRECTORY: directory,
          FIXTURE_ROOT: root,
          FIXTURE_CANONICAL: canonical,
          FIXTURE_PREVIOUS: previous,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(NodeFS.readFileSync(NodePath.join(directory, canonical))).toEqual(
        NodeFS.readFileSync(NodePath.join(directory, previous)),
      );
      expect(NodeFS.readFileSync(NodePath.join(directory, "extracted/t3.exe"), "utf8")).toBe(
        "runtime fixture",
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
