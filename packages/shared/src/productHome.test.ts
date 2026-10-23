// @effect-diagnostics nodeBuiltinImport:off - Disposable ownership fixtures never use real state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ensureProductHome, resolveDefaultProductHome } from "./productHome.ts";
import { symlinksSupported } from "./testing/symlinks.ts";

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-ownership-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  NodeFS.rmSync(root, { recursive: true, force: true });
});
it.each([".shuv2code-v2", ".shuv2code-v2-nightly", ".shuv2code-v2-preview"])(
  "claims empty homes but %s spelling never adopts arbitrary custom state",
  (directory) => {
    const custom = NodePath.join(root, "custom");
    ensureProductHome(custom);
    expect(NodeFS.readFileSync(NodePath.join(custom, ".product-identity"), "utf8")).toBe(
      "s2code\n",
    );
    const legacy = NodePath.join(root, directory);
    NodeFS.mkdirSync(NodePath.join(legacy, "userdata"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacy, "userdata", "statev2.sqlite"), "fork-state");
    expect(() => ensureProductHome(legacy)).toThrow("Cannot establish product ownership");
    expect(NodeFS.existsSync(NodePath.join(legacy, ".product-identity"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(legacy, "userdata", "statev2.sqlite"), "utf8")).toBe(
      "fork-state",
    );
  },
);
it.each([".shuv2code-v2"])("keeps maintainer state in the exact default %s home", (directory) => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  const home = NodePath.join(root, directory);
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(home, "userdata", "statev2.sqlite"), "fork-state");
  expect(resolveDefaultProductHome(root)).toBe(home);
  expect(NodeFS.existsSync(NodePath.join(home, ".product-identity"))).toBe(false);
  ensureProductHome(home);
  expect(NodeFS.readFileSync(NodePath.join(home, "userdata", "statev2.sqlite"), "utf8")).toBe(
    "fork-state",
  );
});
it.each(["nightly", "preview"])(
  "rejects unmarked upstream-like state at the exact %s default",
  (channel) => {
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const home = NodePath.join(root, `.shuv2code-v2-${channel}`);
    NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
    const database = NodePath.join(home, "userdata", "statev2.sqlite");
    NodeFS.writeFileSync(database, "upstream-state");
    expect(() => ensureProductHome(home)).toThrow("Cannot establish product ownership");
    expect(NodeFS.existsSync(NodePath.join(home, ".product-identity"))).toBe(false);
    expect(NodeFS.readFileSync(database, "utf8")).toBe("upstream-state");
    NodeFS.writeFileSync(NodePath.join(home, ".product-identity"), "shuv2code\n");
    ensureProductHome(home);
    expect(NodeFS.readFileSync(database, "utf8")).toBe("upstream-state");
  },
);
it.each(["nightly", "preview"])(
  "claims the empty %s default before state is populated",
  (channel) => {
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const home = NodePath.join(root, `.shuv2code-v2-${channel}`);
    ensureProductHome(home);
    expect(NodeFS.readdirSync(home)).toEqual([".product-identity"]);
    expect(NodeFS.readFileSync(NodePath.join(home, ".product-identity"), "utf8")).toBe("s2code\n");
  },
);

it.each(["", "shuv", "shuv2cod"])(
  "recovers partial default marker %j atomically without claiming ambiguous custom data",
  (marker) => {
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const home = NodePath.join(root, ".shuv2code-v2");
    NodeFS.mkdirSync(home);
    NodeFS.writeFileSync(NodePath.join(home, ".product-identity"), marker);
    NodeFS.writeFileSync(NodePath.join(home, "settings.json"), "retained");
    ensureProductHome(home);
    expect(NodeFS.readFileSync(NodePath.join(home, ".product-identity"), "utf8")).toBe(
      "shuv2code\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(home, "settings.json"), "utf8")).toBe("retained");
    expect(NodeFS.readdirSync(home).sort()).toEqual([".product-identity", "settings.json"]);
    const custom = NodePath.join(root, "custom");
    NodeFS.mkdirSync(custom);
    NodeFS.writeFileSync(NodePath.join(custom, ".product-identity"), marker);
    NodeFS.writeFileSync(NodePath.join(custom, "state.sqlite"), "unproven");
    expect(() => ensureProductHome(custom)).toThrow("Cannot establish product ownership");
    expect(NodeFS.readFileSync(NodePath.join(custom, ".product-identity"), "utf8")).toBe(marker);
  },
);
it("rejects foreign and ambiguous existing homes without changing their files", () => {
  NodeFS.writeFileSync(NodePath.join(root, "statev2.sqlite"), "upstream-state");
  expect(() => ensureProductHome(root)).toThrow("Cannot establish product ownership");
  expect(NodeFS.readdirSync(root)).toEqual(["statev2.sqlite"]);
  NodeFS.writeFileSync(NodePath.join(root, ".product-identity"), "t3code\n");
  expect(() => ensureProductHome(root)).toThrow("another product");
});
it.skipIf(!symlinksSupported)("does not adopt foreign state via a default-home symlink", () => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  const foreign = NodePath.join(root, "foreign");
  NodeFS.mkdirSync(foreign);
  NodeFS.writeFileSync(NodePath.join(foreign, "statev2.sqlite"), "untouched-upstream");
  NodeFS.symlinkSync(foreign, NodePath.join(root, ".shuv2code-v2"), "dir");
  expect(() => ensureProductHome(NodePath.join(root, ".shuv2code-v2"))).toThrow(
    "Cannot establish product ownership",
  );
  expect(NodeFS.readdirSync(foreign)).toEqual(["statev2.sqlite"]);
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

const writeOwnedHome = (name: string, identity: string) => {
  const directory = NodePath.join(root, name);
  NodeFS.mkdirSync(NodePath.join(directory, "userdata"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(directory, ".product-identity"), `${identity}\n`);
  NodeFS.writeFileSync(NodePath.join(directory, "userdata", "statev2.sqlite"), "retained-state");
  return directory;
};

it.each(["", "-nightly", "-preview", "-dev"])(
  "uses the new %s home for a fresh install without creating files",
  (suffix) => {
    const current = NodePath.join(root, `.s2code-v2${suffix}`);
    expect(resolveDefaultProductHome(root, `.s2code-v2${suffix}`)).toBe(current);
    expect(NodeFS.readdirSync(root)).toEqual([]);
    ensureProductHome(current);
    expect(NodeFS.readFileSync(NodePath.join(current, ".product-identity"), "utf8")).toBe(
      "s2code\n",
    );
  },
);

it.each(["", "-nightly", "-preview", "-dev"])(
  "reuses verified V2 state in the old %s home without changing its marker",
  (suffix) => {
    const legacy = writeOwnedHome(`.shuv2code-v2${suffix}`, "shuv2code");
    expect(resolveDefaultProductHome(root, `.s2code-v2${suffix}`)).toBe(legacy);
    ensureProductHome(legacy);
    expect(NodeFS.readFileSync(NodePath.join(legacy, ".product-identity"), "utf8")).toBe(
      "shuv2code\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(legacy, "userdata/statev2.sqlite"), "utf8")).toBe(
      "retained-state",
    );
    expect(NodeFS.existsSync(NodePath.join(root, `.s2code-v2${suffix}`))).toBe(false);
  },
);

it("does not mistake a marker-only new home for state", () => {
  const current = NodePath.join(root, ".s2code-v2-nightly");
  ensureProductHome(current);
  const legacy = writeOwnedHome(".shuv2code-v2-nightly", "shuv2code");
  expect(resolveDefaultProductHome(root, ".s2code-v2-nightly")).toBe(legacy);
  expect(NodeFS.readdirSync(current)).toEqual([".product-identity"]);
});

it("requires an explicit choice when both old and new homes contain state", () => {
  const current = writeOwnedHome(".s2code-v2", "s2code");
  const legacy = writeOwnedHome(".shuv2code-v2", "shuv2code");
  expect(() => resolveDefaultProductHome(root)).toThrow("Set S2CODE_HOME to choose one");
  expect(NodeFS.readFileSync(NodePath.join(current, ".product-identity"), "utf8")).toBe("s2code\n");
  expect(NodeFS.readFileSync(NodePath.join(legacy, ".product-identity"), "utf8")).toBe(
    "shuv2code\n",
  );
});

it.each(["t3code", "shuv", "", "shuv2code-v1"])(
  "refuses automatic adoption of legacy data with unproven marker %j",
  (marker) => {
    writeOwnedHome(".shuv2code-v2", marker);
    expect(() => resolveDefaultProductHome(root)).toThrow(
      /Cannot establish product ownership|another product/,
    );
    expect(NodeFS.existsSync(NodePath.join(root, ".s2code-v2"))).toBe(false);
  },
);

it("reuses the pre-marker V2 default without importing older fork generations", () => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  NodeFS.mkdirSync(NodePath.join(root, ".shuv2code"));
  NodeFS.writeFileSync(NodePath.join(root, ".shuv2code/state.sqlite"), "v1");
  expect(resolveDefaultProductHome(root)).toBe(NodePath.join(root, ".s2code-v2"));
  NodeFS.mkdirSync(NodePath.join(root, ".shuv2code-v2"));
  NodeFS.writeFileSync(NodePath.join(root, ".shuv2code-v2/statev2.sqlite"), "existing-v2");
  expect(resolveDefaultProductHome(root)).toBe(NodePath.join(root, ".shuv2code-v2"));
  expect(NodeFS.readFileSync(NodePath.join(root, ".shuv2code/state.sqlite"), "utf8")).toBe("v1");
});

it("does not claim populated canonical defaults without a marker", () => {
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  const current = NodePath.join(root, ".s2code-v2");
  NodeFS.mkdirSync(current);
  NodeFS.writeFileSync(NodePath.join(current, "state.sqlite"), "unproven");
  expect(() => ensureProductHome(current)).toThrow("Cannot establish product ownership");
  expect(() => resolveDefaultProductHome(root)).toThrow("Cannot establish product ownership");
  expect(NodeFS.existsSync(NodePath.join(current, ".product-identity"))).toBe(false);
});

it.skipIf(!symlinksSupported)(
  "recognizes two names for the same verified home without merging",
  () => {
    const current = writeOwnedHome(".s2code-v2", "shuv2code");
    NodeFS.symlinkSync(current, NodePath.join(root, ".shuv2code-v2"), "dir");
    expect(resolveDefaultProductHome(root)).toBe(current);
    expect(NodeFS.readFileSync(NodePath.join(current, ".product-identity"), "utf8")).toBe(
      "shuv2code\n",
    );
  },
);

it.skipIf(!symlinksSupported)("never adopts a legacy home that aliases upstream state", () => {
  const upstream = writeOwnedHome(".t3", "shuv2code");
  NodeFS.symlinkSync(upstream, NodePath.join(root, ".shuv2code-v2"), "dir");
  expect(() => resolveDefaultProductHome(root)).toThrow("upstream .t3 home");
  expect(NodeFS.existsSync(NodePath.join(root, ".s2code-v2"))).toBe(false);
});
