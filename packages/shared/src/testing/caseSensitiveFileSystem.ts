// @effect-diagnostics nodeBuiltinImport:off - one synchronous probe at module load, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Skip fixtures that need two names differing only by case; default macOS APFS and Windows fold case. */
export const caseSensitiveTempDir: boolean = (() => {
  let directory: string | undefined;
  try {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-case-probe-"));
    NodeFS.writeFileSync(NodePath.join(directory, "probe"), "");
    return !NodeFS.existsSync(NodePath.join(directory, "PROBE"));
  } catch {
    return false;
  } finally {
    try {
      if (directory !== undefined) NodeFS.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
})();
