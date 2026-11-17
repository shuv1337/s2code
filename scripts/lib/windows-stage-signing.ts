// @effect-diagnostics nodeBuiltinImport:off -- Inspect only staged artifact copies, never installed binaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { signWithJsign } from "./windows-jsign.ts";

export const WindowsSigningConfig = Config.all({
  endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT").pipe(Config.option),
  accountName: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME").pipe(Config.option),
  certificateProfileName: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME").pipe(
    Config.option,
  ),
});

export class WindowsStageSigningError extends Schema.TaggedError<WindowsStageSigningError>()(
  "WindowsStageSigningError",
  { detail: Schema.String },
) {}

/** Detect PE images by headers, including extensionless helpers; never follow links. */
export async function windowsPeFiles(
  root: string,
  excluded: ReadonlyArray<string> = [],
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await NodeFSP.readdir(directory)).sort()) {
      const file = NodePath.join(directory, name);
      if (
        excluded.some((pattern) =>
          NodePath.posix.matchesGlob(
            NodePath.relative(root, file).split(NodePath.sep).join("/"),
            pattern,
          ),
        )
      )
        continue;
      const stat = await NodeFSP.lstat(file);
      if (stat.isSymbolicLink())
        throw new Error(`Refusing a symlink in Windows signing stage: ${file}`);
      if (stat.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!stat.isFile() || stat.size < 64) continue;
      const fd = await NodeFSP.open(file, "r");
      try {
        const dos = Buffer.alloc(64);
        await fd.read(dos, 0, dos.length, 0);
        if (dos.readUInt16LE(0) !== 0x5a4d) continue;
        const offset = dos.readUInt32LE(0x3c);
        if (offset < 64 || offset + 4 > stat.size) throw new Error(`Invalid PE header: ${file}`);
        const pe = Buffer.alloc(4);
        await fd.read(pe, 0, pe.length, offset);
        if (pe.readUInt32LE(0) !== 0x00004550) throw new Error(`Invalid PE signature: ${file}`);
        found.push(file);
      } finally {
        await fd.close();
      }
    }
  };
  await walk(root);
  return found;
}

export const signWindowsFile = Effect.fn("signWindowsFile")(function* (file: string) {
  const signing = yield* WindowsSigningConfig;
  const endpoint = Option.getOrUndefined(signing.endpoint);
  const account = Option.getOrUndefined(signing.accountName);
  const profile = Option.getOrUndefined(signing.certificateProfileName);
  if (!endpoint || !account || !profile) {
    return yield* new WindowsStageSigningError({
      detail: "Missing Azure configuration for signed Windows stage.",
    });
  }
  if ((yield* HostProcess.Platform) !== "win32") {
    yield* signWithJsign(file);
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: path.dirname(file),
    prefix: ".azure-sign-",
  });
  const copy = path.join(directory, path.basename(file));
  yield* fs.copyFile(file, copy);
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "Invoke-TrustedSigning",
    `-Endpoint ${quote(endpoint)}`,
    `-CodeSigningAccountName ${quote(account)}`,
    `-CertificateProfileName ${quote(profile)}`,
    "-FileDigest 'SHA256'",
    "-TimestampRfc3161 'http://timestamp.acs.microsoft.com'",
    "-TimestampDigest 'SHA256'",
    `-Files ${quote(copy)}`,
  ].join(" ");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = Number(
    yield* spawner.exitCode(
      ChildProcess.make("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdout: "inherit",
        stderr: "inherit",
      }),
    ),
  );
  if (exitCode !== 0)
    return yield* new WindowsStageSigningError({
      detail: `Signing failed for ${file} (exit ${exitCode}).`,
    });
  yield* fs.rename(copy, file);
});

export const signWindowsStage = Effect.fn("signWindowsStage")(function* (
  root: string,
  excluded: ReadonlyArray<string> = [],
) {
  const files = yield* Effect.tryPromise({
    try: () => windowsPeFiles(root, excluded),
    catch: () =>
      new WindowsStageSigningError({
        detail: "Could not safely enumerate the Windows signing stage.",
      }),
  });
  for (const file of files) yield* signWindowsFile(file).pipe(Effect.scoped);
});
