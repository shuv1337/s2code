// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

// A test that runs from a git hook or an agent shell inherits GIT_DIR and friends. Git then ignores
// the temp repo a test just created, so `git init --bare` and `git config` rewrite the outer
// repository's .git/config. Code under test spawns git with `{ ...process.env }`, so the variables
// have to leave `process.env` itself; a per-call `env` cannot remove them.
const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
]);

/**
 * Strips the repository selectors and every `GIT_CONFIG*` variable from `process.env`, sets
 * `GIT_CONFIG_NOSYSTEM`, and stops git's repository discovery at `root` (default: the OS temp
 * directory). Call it from a package's vitest setup file, or at the top of a test file that runs
 * git in a package without one. Anything that needs git config re-adds it afterwards.
 */
export function isolateGitEnv(root: string = NodeFS.realpathSync(NodeOS.tmpdir())): void {
  for (const key of Object.keys(process.env)) {
    const name = key.toUpperCase();
    if (REPOSITORY_SELECTORS.has(name) || name.startsWith("GIT_CONFIG")) {
      delete process.env[key];
    }
  }
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_CEILING_DIRECTORIES = root;
}
