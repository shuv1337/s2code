// @effect-diagnostics nodeBuiltinImport:off -- Native helper ownership checks at the filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Presence only, including links: never read or execute an upstream-named helper to identify it. */
export async function capturePathExists(path: string): Promise<boolean> {
  return NodeFSP.lstat(path)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
}

/** Reject existing links below the XDG data root; these path checks do not prevent concurrent directory replacement. */
export async function assertCaptureDirectories(dataHome: string, directory: string) {
  const root = NodePath.resolve(dataHome);
  for (
    let current = NodePath.resolve(directory);
    current !== root;
    current = NodePath.dirname(current)
  ) {
    if (current === NodePath.dirname(current)) throw new Error("Invalid capture helper path.");
    const stat = await NodeFSP.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error("The capture helper directory is not a regular directory.");
  }
}

export async function regularCaptureFile(path: string): Promise<Buffer | undefined> {
  const stat = await NodeFSP.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(
      "Capture helper files must be regular files. Remove the conflicting link before trying again.",
    );
  return NodeFSP.readFile(path);
}
