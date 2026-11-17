// @effect-diagnostics nodeBuiltinImport:off -- Real temporary payloads; signing is an offline recording stub.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { windowsPeFiles } from "./lib/windows-stage-signing.ts";
import { resolveWindowsServerAsarIgnoreGlobs } from "./build-desktop-artifact.ts";

import { copySignedWindowsSidecar, signWindowsExtraResources } from "./windows-after-pack.ts";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "s2-windows-sign-"));
  const files = [
    "S2Code.exe", // builder owns the root and app.asar.unpacked
    "resources/app.asar.unpacked/desktop.node",
    "resources/server.asar.unpacked/nested/addon.node",
    "resources/server.asar.unpacked/nested/conpty.DLL",
    "resources/t3-resource-monitor.exe",
    "resources/native/ffmpeg.exe",
    "resources/native/extensionless",
    "resources/server.asar",
    "resources/wsl-runtime.tar.gz",
    "resources/data/readme.txt",
  ];
  for (const name of files) {
    const file = NodePath.join(root, name);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    const bytes = Buffer.alloc(512);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(128, 0x3c);
    bytes.writeUInt32LE(0x4550, 128);
    await NodeFSP.writeFile(
      file,
      /(?:exe|DLL|node|extensionless)$/.test(name) ? bytes : "unchanged fixture",
    );
  }
  return {
    root,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

describe("signed Windows extra resources", () => {
  it("signs every extra-resource execution component without duplicating builder-owned files", async () => {
    await using app = await fixture();
    const signed: string[] = [];
    await signWindowsExtraResources(
      {
        appOutDir: app.root,
        electronPlatformName: "win32",
      },
      async (file) => {
        signed.push(NodePath.relative(app.root, file).split(NodePath.sep).join("/"));
      },
    );
    expect(signed.sort()).toEqual([
      "resources/native/extensionless",
      "resources/native/ffmpeg.exe",
      "resources/t3-resource-monitor.exe",
    ]);
  });

  it("refuses skipped signatures and an unexpected platform", async () => {
    await using app = await fixture();
    const context = {
      appOutDir: app.root,
      electronPlatformName: "win32",
    };
    await expect(
      signWindowsExtraResources(context, async () => {
        throw new Error("signing failed");
      }),
    ).rejects.toThrow("signing failed");
    await expect(
      signWindowsExtraResources({ ...context, electronPlatformName: "linux" }),
    ).rejects.toThrow("only run");
  });

  it("does not follow a resource symlink outside the package", async () => {
    await using app = await fixture();
    const outside = NodePath.join(app.root, "outside.dll");
    await NodeFSP.writeFile(outside, "outside");
    await NodeFSP.symlink(outside, NodePath.join(app.root, "resources/escape.dll"));
    const signed: string[] = [];
    await expect(
      signWindowsExtraResources(
        {
          appOutDir: app.root,
          electronPlatformName: "win32",
        },
        async (file) => {
          signed.push(file);
        },
      ),
    ).rejects.toThrow("symlink");
    expect(signed).not.toContain(outside);
    expect(await NodeFSP.readFile(outside, "utf8")).toBe("outside");
  });
});

it("uses exactly the ASAR exclusions before signing, without following excluded .bin links", async () => {
  await using app = await fixture();
  const stage = NodePath.join(app.root, "server-stage");
  const wanted = NodePath.join(stage, "node_modules/addon/wanted.node");
  await NodeFSP.mkdir(NodePath.dirname(wanted), { recursive: true });
  const bytes = await NodeFSP.readFile(NodePath.join(app.root, "S2Code.exe"));
  await NodeFSP.writeFile(wanted, bytes);
  for (const name of ["node_modules/.bin/tool", "node_modules/nested/node_modules/.bin/tool"]) {
    const file = NodePath.join(stage, name);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.symlink(wanted, file);
  }
  const foreign = NodePath.join(stage, "node_modules/node-pty/prebuilds/win32-arm64/conpty.node");
  await NodeFSP.mkdir(NodePath.dirname(foreign), { recursive: true });
  await NodeFSP.writeFile(foreign, bytes);
  await NodeFSP.writeFile(NodePath.join(stage, "linux.node"), Buffer.alloc(512, 42));
  expect(await windowsPeFiles(stage, resolveWindowsServerAsarIgnoreGlobs("x64"))).toEqual([wanted]);
});

it("copies the signed sidecar byte-for-byte after builder transforms, refusing replacement", async () => {
  await using app = await fixture();
  const source = NodePath.join(app.root, "project/apps/desktop/prod-resources/windows-server");
  const destination = NodePath.join(app.root, "output");
  await NodeFSP.mkdir(NodePath.join(source, "server.asar.unpacked"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(destination, "resources"), { recursive: true });
  const native = await NodeFSP.readFile(NodePath.join(app.root, "S2Code.exe"));
  await NodeFSP.writeFile(NodePath.join(source, "server.asar.unpacked/native.node"), native);
  await NodeFSP.writeFile(NodePath.join(source, "server.asar"), "immutable ASAR header");
  const context = {
    appOutDir: destination,
    electronPlatformName: "win32",
    packager: { projectDir: NodePath.join(app.root, "project") },
  };
  await copySignedWindowsSidecar(context);
  expect(
    await NodeFSP.readFile(
      NodePath.join(destination, "resources/server.asar.unpacked/native.node"),
    ),
  ).toEqual(native);
  expect(await NodeFSP.readFile(NodePath.join(destination, "resources/server.asar"), "utf8")).toBe(
    "immutable ASAR header",
  );
  await expect(copySignedWindowsSidecar(context)).rejects.toThrow();
});
