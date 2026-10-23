// @effect-diagnostics nodeBuiltinImport:off -- Generated WSL ownership logic runs only in disposable homes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ensureProductHome } from "@t3tools/shared/productHome";
import { buildWslRuntimeInstallScript } from "./DesktopWslEnvironment.ts";

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "reuses verified legacy WSL state and refuses two populated homes",
  async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "s2code-wsl-upgrade-"));
    const legacy = NodePath.join(home, ".shuv2code-v2-nightly");
    const current = NodePath.join(home, ".s2code-v2-nightly");
    try {
      await NodeFSP.mkdir(legacy);
      await NodeFSP.writeFile(NodePath.join(legacy, ".product-identity"), "shuv2code\n");
      await NodeFSP.writeFile(NodePath.join(legacy, "settings.json"), "existing state");
      const run = () =>
        NodeChildProcess.spawnSync("bash", ["-s"], {
          input: `flock() { :; }\n${buildWslRuntimeInstallScript("/missing/archive.tar.gz", "runtime-test", "0".repeat(64), "1.2.3-nightly.20261014.1")}`,
          env: { PATH: process.env.PATH, HOME: home },
          encoding: "utf8",
        });
      expect(run().status).not.toBe(0);
      expect((await NodeFSP.stat(NodePath.join(legacy, "wsl-runtime"))).isDirectory()).toBe(true);
      await expect(NodeFSP.stat(current)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await NodeFSP.readFile(NodePath.join(legacy, ".product-identity"), "utf8")).toBe(
        "shuv2code\n",
      );
      await NodeFSP.mkdir(current);
      await NodeFSP.writeFile(NodePath.join(current, "settings.json"), "current state");
      expect(run().stderr).toContain("Both s2code and shuv2code WSL homes contain state");
      expect(await NodeFSP.readFile(NodePath.join(current, "settings.json"), "utf8")).toBe(
        "current state",
      );
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "ignores a marker-only legacy WSL home when the canonical home has state",
  async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "s2code-wsl-empty-"));
    const legacy = NodePath.join(home, ".shuv2code-v2-nightly");
    const current = NodePath.join(home, ".s2code-v2-nightly");
    try {
      for (const directory of [legacy, current]) {
        await NodeFSP.mkdir(directory);
        await NodeFSP.writeFile(NodePath.join(directory, ".product-identity"), "s2code\n");
      }
      await NodeFSP.writeFile(NodePath.join(current, "settings.json"), "existing state");
      const result = NodeChildProcess.spawnSync("bash", ["-s"], {
        input: `flock() { :; }\n${buildWslRuntimeInstallScript("/missing/archive.tar.gz", "runtime-test", "0".repeat(64), "1.2.3-nightly.20261014.1")}`,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
      });
      expect(result.stderr).not.toContain("Both s2code and shuv2code");
      expect((await NodeFSP.stat(NodePath.join(current, "wsl-runtime"))).isDirectory()).toBe(true);
      expect(await NodeFSP.readdir(legacy)).toEqual([".product-identity"]);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(HostProcess.Platform.defaultValue() === "win32").each(["nightly", "preview"])(
  "claims an empty %s WSL home before runtime population and mounted-tree fallback",
  async (channel) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-wsl-home-"));
    const root = NodePath.join(home, `.s2code-v2-${channel}`);
    try {
      // This test isolates ownership from Linux flock availability; the native
      // runtime suite exercises the real lock in an actual Linux/WSL shell.
      const script = `flock() { :; }\n${buildWslRuntimeInstallScript("/missing/test-archive.tar.gz", "runtime-test", "0".repeat(64), `1.2.3-${channel}.20261014.1`)}\n`;
      const result = NodeChildProcess.spawnSync("bash", ["-s"], {
        input: script,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).not.toBe(0); // archive failure still leaves a valid home for fallback
      expect(await NodeFSP.readFile(NodePath.join(root, ".product-identity"), "utf8")).toBe(
        "s2code\n",
      );
      expect(() => ensureProductHome(root)).not.toThrow();
      expect((await NodeFSP.readdir(root)).sort()).toEqual([".product-identity", "wsl-runtime"]);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);

it
  .skipIf(HostProcess.Platform.defaultValue() === "win32")
  .each(["foreign", "unmarked", "stable-unmarked"])(
  "does not populate a %s nonempty WSL home",
  async (kind) => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-wsl-unowned-"));
    const root = NodePath.join(
      home,
      kind === "stable-unmarked" ? ".s2code-v2" : ".s2code-v2-nightly",
    );
    try {
      await NodeFSP.mkdir(root);
      await NodeFSP.writeFile(NodePath.join(root, "state.sqlite"), "untouched");
      if (kind === "foreign")
        await NodeFSP.writeFile(NodePath.join(root, ".product-identity"), "t3code\n");
      const result = NodeChildProcess.spawnSync("bash", ["-s"], {
        input: `flock() { :; }\n${buildWslRuntimeInstallScript("/missing/test-archive.tar.gz", "runtime-test", "0".repeat(64), kind === "stable-unmarked" ? "1.2.3" : "1.2.3-nightly.20261014.1")}`,
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(await NodeFSP.readFile(NodePath.join(root, "state.sqlite"), "utf8")).toBe("untouched");
      await expect(NodeFSP.stat(NodePath.join(root, "wsl-runtime"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  },
);
