// @effect-diagnostics nodeBuiltinImport:off - drives the real git binary against temp directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { isolateGitEnv } from "./gitEnv.ts";

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" });

const makeRoot = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeFS.realpathSync(NodeOS.tmpdir()), "t3-git-env-"));

// Registers the two variables the helper sets so `vi.unstubAllEnvs` restores them.
const stubHelperOutputs = () => {
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "");
  vi.stubEnv("GIT_CEILING_DIRECTORIES", "");
};

it("keeps an inherited GIT_DIR from rewriting the outer repository", () => {
  const root = makeRoot();
  stubHelperOutputs();
  try {
    // Also keeps this test off the outer repository when it runs inside a git hook.
    isolateGitEnv(root);

    const outer = NodePath.join(root, "outer");
    git(root, "init", "--quiet", outer);
    const outerGitDir = NodePath.join(outer, ".git");
    const outerConfig = NodePath.join(outerGitDir, "config");
    const before = NodeFS.readFileSync(outerConfig);

    // What a pre-commit hook exports.
    vi.stubEnv("GIT_DIR", outerGitDir);
    vi.stubEnv("GIT_INDEX_FILE", NodePath.join(outerGitDir, "index"));
    isolateGitEnv(root);

    const remote = NodePath.join(root, "remote");
    const checkout = NodePath.join(root, "checkout");
    NodeFS.mkdirSync(remote);
    NodeFS.mkdirSync(checkout);
    git(remote, "init", "--bare");
    git(checkout, "init");
    git(checkout, "config", "user.name", "T3 Code Test");

    assert.deepStrictEqual(NodeFS.readFileSync(outerConfig), before);
    assert.include(NodeFS.readFileSync(NodePath.join(remote, "config"), "utf8"), "bare = true");
    assert.include(
      NodeFS.readFileSync(NodePath.join(checkout, ".git", "config"), "utf8"),
      "T3 Code Test",
    );
  } finally {
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("drops repository selectors and config overrides and bounds discovery at the temp root", () => {
  stubHelperOutputs();
  const inherited = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_PARAMETERS",
  ];
  try {
    for (const name of inherited) vi.stubEnv(name, "/inherited");

    isolateGitEnv("/temp-root");

    for (const name of inherited) assert.isUndefined(process.env[name], name);
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(process.env.GIT_CEILING_DIRECTORIES, "/temp-root");
  } finally {
    vi.unstubAllEnvs();
  }
});
