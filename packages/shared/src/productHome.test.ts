// @effect-diagnostics nodeBuiltinImport:off - Disposable ownership fixtures never use real state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ensureProductHome } from "./productHome.ts";
import { symlinksSupported } from "./testing/symlinks.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ownership-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  NodeFS.rmSync(root, { recursive: true, force: true });
});
it("claims empty custom homes and keeps existing default fork homes", () => {
  const custom = NodePath.join(root, "custom");
  ensureProductHome(custom);
  expect(NodeFS.readFileSync(NodePath.join(custom, ".product-identity"), "utf8")).toBe(
    "shuv2code\n",
  );
  const legacy = NodePath.join(root, ".shuv2code-v2");
  NodeFS.mkdirSync(NodePath.join(legacy, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(legacy, "userdata", "statev2.sqlite"), "fork-state");
  ensureProductHome(legacy);
  expect(NodeFS.readFileSync(NodePath.join(legacy, "userdata", "statev2.sqlite"), "utf8")).toBe(
    "fork-state",
  );
});
it("rejects foreign and ambiguous existing homes without changing their files", () => {
  NodeFS.writeFileSync(NodePath.join(root, "statev2.sqlite"), "upstream-state");
  expect(() => ensureProductHome(root)).toThrow("Cannot establish product ownership");
  expect(NodeFS.readdirSync(root)).toEqual(["statev2.sqlite"]);
  NodeFS.writeFileSync(NodePath.join(root, ".product-identity"), "t3code\n");
  expect(() => ensureProductHome(root)).toThrow("another product");
});
it.skipIf(!symlinksSupported)("rejects upstream homes and paths that alias them", () => {
  const upstream = NodePath.join(root, ".t3");
  NodeFS.mkdirSync(upstream);
  const alias = NodePath.join(root, ".shuv2code-v2");
  NodeFS.symlinkSync(upstream, alias, "dir");
  expect(() => ensureProductHome(alias)).toThrow("upstream .t3 home");
  expect(NodeFS.readdirSync(upstream)).toEqual([]);
});
it.skipIf(!symlinksSupported)(
  "supports worktree .t3 state but refuses runtime links outside its home",
  () => {
    NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: disposable");
    const home = NodePath.join(root, ".t3");
    ensureProductHome(home);
    const foreign = NodePath.join(root, "foreign");
    NodeFS.mkdirSync(foreign);
    NodeFS.symlinkSync(foreign, NodePath.join(home, "runtime"), "dir");
    expect(() => ensureProductHome(home)).toThrow("foreign runtime path");
    expect(NodeFS.readdirSync(foreign)).toEqual([]);
  },
);
it.skipIf(!symlinksSupported).each(["symlink", "hardlink"])(
  "refuses a %s database shared with another home",
  (kind) => {
    const home = NodePath.join(root, ".shuv2code-v2");
    NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
    const source = NodePath.join(root, "upstream.sqlite");
    NodeFS.writeFileSync(source, "untouched-upstream");
    const destination = NodePath.join(home, "userdata", "statev2.sqlite");
    if (kind === "symlink") NodeFS.symlinkSync(source, destination);
    else NodeFS.linkSync(source, destination);
    expect(() => ensureProductHome(home)).toThrow(/Refusing (foreign|shared)/);
    expect(NodeFS.readFileSync(source, "utf8")).toBe("untouched-upstream");
    expect(NodeFS.existsSync(NodePath.join(home, ".product-identity"))).toBe(false);
  },
);
it.each([".t3", ".T3"])("refuses the upstream home %s even when HOME is a git checkout", (name) => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: dotfiles");
  const home = NodePath.join(root, name);
  expect(() => ensureProductHome(home)).toThrow("upstream .t3 home");
  expect(NodeFS.existsSync(home)).toBe(false);
});
