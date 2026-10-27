// @effect-diagnostics nodeBuiltinImport:off -- Native extension installation uses isolated filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import type { Message, MessageBus } from "dbus-next";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GnomeCaptureSetup, installGnomeCaptureBundle } from "./GnomeCaptureSetup.ts";
import { GNOME_CAPTURE_FILES, GNOME_CAPTURE_UUID } from "./gnomeCaptureBundle.ts";

let dataHome: string;
const bundle = NodePath.resolve(import.meta.dirname, "../../gnome-extension");
const installedPath = () => NodePath.join(dataHome, "gnome-shell/extensions", GNOME_CAPTURE_UUID);
beforeEach(async () => {
  dataHome = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-gnome-setup-test-"));
});
afterEach(async () => {
  await NodeFSP.rm(dataHome, { recursive: true, force: true });
});

function fixture(
  options: {
    state?: number;
    version?: number;
    shell?: string;
    enabled?: boolean;
    accepted?: boolean;
    error?: string;
    legacyState?: number;
  } = {},
) {
  const call = vi.fn(async (message: Message) => ({
    body: [
      message.member === "GetAll"
        ? {
            ShellVersion: { value: options.shell ?? "50.0" },
            UserExtensionsEnabled: { value: options.enabled ?? true },
          }
        : message.member === "GetExtensionInfo"
          ? message.body[0] === GNOME_CAPTURE_UUID
            ? {
                ...(options.state === undefined ? {} : { state: { value: options.state } }),
                ...(options.version === undefined ? {} : { version: { value: options.version } }),
                error: { value: options.error ?? "" },
              }
            : options.legacyState === undefined
              ? {}
              : { state: { value: options.legacyState } }
          : (options.accepted ?? true),
    ],
  }));
  const disconnect = vi.fn();
  const bus = Object.assign(new NodeEvents.EventEmitter(), { call, disconnect });
  return {
    setup: new GnomeCaptureSetup({ bundle, dataHome }, bus as unknown as MessageBus),
    call,
    disconnect,
    bus,
  };
}

it("installs exactly the bundled payload offline and leaves other extensions alone", async () => {
  const other = NodePath.join(dataHome, "gnome-shell/extensions/other@example");
  await NodeFSP.mkdir(other, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(other, "keep.txt"), "keep");
  await installGnomeCaptureBundle({ bundle, dataHome });
  expect((await NodeFSP.readdir(installedPath())).sort()).toEqual([...GNOME_CAPTURE_FILES].sort());
  for (const file of GNOME_CAPTURE_FILES) {
    expect(await NodeFSP.readFile(NodePath.join(installedPath(), file))).toEqual(
      await NodeFSP.readFile(NodePath.join(bundle, file)),
    );
  }
  expect(await NodeFSP.readFile(NodePath.join(other, "keep.txt"), "utf8")).toBe("keep");
});

it("preserves the replaced extension as a recoverable backup", async () => {
  await installGnomeCaptureBundle({ bundle, dataHome });
  await NodeFSP.writeFile(NodePath.join(installedPath(), "custom.txt"), "local change");
  await installGnomeCaptureBundle({ bundle, dataHome });
  const backups = NodePath.join(dataHome, "s2code/extension-backups");
  const [backup] = await NodeFSP.readdir(backups);
  expect(
    await NodeFSP.readFile(
      NodePath.join(backups, backup!, GNOME_CAPTURE_UUID, "custom.txt"),
      "utf8",
    ),
  ).toBe("local change");
});

it("coexists with the upstream UUID through setup, upgrade and disable", async () => {
  const upstream = NodePath.join(dataHome, "gnome-shell/extensions/snap-shot@t3.codes");
  await NodeFSP.mkdir(upstream, { recursive: true });
  const upstreamMetadata = JSON.stringify({
    uuid: "snap-shot@t3.codes",
    version: 2,
    "shell-version": ["50"],
  });
  await NodeFSP.writeFile(NodePath.join(upstream, "metadata.json"), upstreamMetadata);
  await NodeFSP.writeFile(NodePath.join(upstream, "extension.js"), "upstream extension");
  const initial = fixture();
  expect(await initial.setup.state()).toMatchObject({
    status: "not-installed",
    message: expect.stringContaining("snap-shot@t3.codes"),
  });
  await initial.setup.perform("install-extension");
  initial.setup.close();
  await NodeFSP.writeFile(
    NodePath.join(installedPath(), "metadata.json"),
    JSON.stringify({ uuid: GNOME_CAPTURE_UUID, version: 1, "shell-version": ["50"] }),
  );
  const upgrade = fixture({ state: 1, version: 1 });
  expect((await upgrade.setup.state()).status).toBe("update-required");
  await upgrade.setup.perform("install-extension");
  upgrade.setup.close();
  const loaded = fixture({ state: 1, version: 3 });
  await loaded.setup.perform("disable-extension");
  expect((await loaded.setup.state()).message).toContain("does not revoke");
  for (const calls of [initial.call.mock.calls, upgrade.call.mock.calls, loaded.call.mock.calls]) {
    for (const [message] of calls) {
      if (message.member === "GetExtensionInfo")
        expect([GNOME_CAPTURE_UUID, "snap-shot@t3.codes"]).toContain(message.body[0]);
      else if (message.member !== "GetAll") expect(message.body).toEqual([GNOME_CAPTURE_UUID]);
    }
  }
  loaded.setup.close();
  expect(await NodeFSP.readFile(NodePath.join(upstream, "metadata.json"), "utf8")).toBe(
    upstreamMetadata,
  );
  expect(await NodeFSP.readFile(NodePath.join(upstream, "extension.js"), "utf8")).toBe(
    "upstream extension",
  );
  expect(await NodeFSP.readdir(upstream)).toEqual(["extension.js", "metadata.json"]);
});

it("detects a loaded upstream-named GNOME extension outside the local install directory, read-only", async () => {
  const { setup, call } = fixture({ legacyState: 1 });
  expect(await setup.state()).toMatchObject({
    status: "not-installed",
    message: expect.stringContaining("snap-shot@t3.codes"),
  });
  expect(call.mock.calls.every(([message]) => message.member.startsWith("Get"))).toBe(true);
  await expect(NodeFSP.stat(NodePath.join(dataHome, "gnome-shell"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  setup.close();
});

it.each(["foreign", "missing", "linked"] as const)(
  "refuses replacement and disable with %s ownership metadata",
  async (kind) => {
    await NodeFSP.mkdir(installedPath(), { recursive: true });
    const metadataPath = NodePath.join(installedPath(), "metadata.json");
    const foreign = JSON.stringify({
      uuid: "snap-shot@t3.codes",
      version: 3,
      "shell-version": ["50"],
    });
    if (kind === "foreign") await NodeFSP.writeFile(metadataPath, foreign);
    if (kind === "linked")
      await NodeFSP.symlink(NodePath.join(bundle, "metadata.json"), metadataPath);
    await NodeFSP.writeFile(NodePath.join(installedPath(), "extension.js"), "do not replace");
    await expect(installGnomeCaptureBundle({ bundle, dataHome })).rejects.toThrow();
    const { setup, call } = fixture({ state: 1, version: 3 });
    expect((await setup.state()).status).toBe("error");
    await expect(setup.perform("disable-extension")).rejects.toThrow();
    expect(call.mock.calls.some(([message]) => message.member === "DisableExtension")).toBe(false);
    setup.close();
    expect(await NodeFSP.readFile(NodePath.join(installedPath(), "extension.js"), "utf8")).toBe(
      "do not replace",
    );
    if (kind === "foreign") expect(await NodeFSP.readFile(metadataPath, "utf8")).toBe(foreign);
    await expect(
      NodeFSP.stat(NodePath.join(dataHome, "s2code/extension-backups")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("refuses setup through a linked extension parent without changing upstream state", async () => {
  const upstream = NodePath.join(dataHome, "upstream");
  await NodeFSP.mkdir(upstream);
  await NodeFSP.mkdir(NodePath.join(dataHome, "gnome-shell"));
  await NodeFSP.symlink(upstream, NodePath.join(dataHome, "gnome-shell/extensions"));
  await expect(installGnomeCaptureBundle({ bundle, dataHome })).rejects.toThrow(
    "regular directory",
  );
  expect(await NodeFSP.readdir(upstream)).toEqual([]);
});

it("does not damage an installed extension if a bundled file is missing", async () => {
  await installGnomeCaptureBundle({ bundle, dataHome });
  const incomplete = NodePath.join(dataHome, "incomplete");
  await NodeFSP.mkdir(incomplete);
  await NodeFSP.copyFile(
    NodePath.join(bundle, "metadata.json"),
    NodePath.join(incomplete, "metadata.json"),
  );
  await expect(installGnomeCaptureBundle({ bundle: incomplete, dataHome })).rejects.toThrow();
  expect(await NodeFSP.readFile(NodePath.join(installedPath(), "extension.js"))).toEqual(
    await NodeFSP.readFile(NodePath.join(bundle, "extension.js")),
  );
  expect(await NodeFSP.readdir(NodePath.dirname(installedPath()))).toEqual([GNOME_CAPTURE_UUID]);
});

it("refuses to replace symlinks or downgrade a newer extension", async () => {
  await NodeFSP.mkdir(NodePath.dirname(installedPath()), { recursive: true });
  await NodeFSP.symlink(bundle, installedPath());
  await expect(installGnomeCaptureBundle({ bundle, dataHome })).rejects.toThrow(
    "regular directory",
  );
  await NodeFSP.unlink(installedPath());
  await installGnomeCaptureBundle({ bundle, dataHome });
  await NodeFSP.writeFile(
    NodePath.join(installedPath(), "metadata.json"),
    JSON.stringify({ uuid: GNOME_CAPTURE_UUID, version: 99, "shell-version": ["50"] }),
  );
  await expect(installGnomeCaptureBundle({ bundle, dataHome })).rejects.toThrow("newer extension");
});

it.each([
  [{ state: 1, version: 3 }, "enabled"],
  [{ state: 1, version: 2, shell: "51.0" }, "update-required"],
  [{ state: 2, version: 3, enabled: false }, "extensions-disabled"],
  [{ shell: "52.0" }, "unsupported"],
] as const)("reports GNOME setup state %j", async (options, status) => {
  const { setup, call } = fixture(options);
  expect((await setup.state()).status).toBe(status);
  expect(call.mock.calls.map(([message]) => message.member).sort()).toEqual([
    "GetAll",
    "GetExtensionInfo",
    "GetExtensionInfo",
  ]);
  setup.close();
});

it("requires login for local installs and updates until the new version is loaded", async () => {
  await installGnomeCaptureBundle({ bundle, dataHome });
  for (const options of [{}, { state: 1, version: 1 }]) {
    const { setup } = fixture(options);
    expect((await setup.state()).status).toBe("restart-required");
    setup.close();
  }
  const { setup } = fixture({ state: 2, version: 3 });
  expect((await setup.state()).status).toBe("disabled");
  setup.close();
});

it("never changes the global user-extensions preference", async () => {
  const { setup, call } = fixture({ state: 2, version: 3, enabled: false });
  await expect(setup.perform("enable-extension")).rejects.toThrow("GNOME has disabled");
  expect(call.mock.calls.every(([message]) => message.member.startsWith("Get"))).toBe(true);
  setup.close();
});

it("still disables a fork extension which failed to load", async () => {
  await installGnomeCaptureBundle({ bundle, dataHome });
  const { setup, call } = fixture({ state: 3, version: 3, error: "Load failed" });
  expect((await setup.state()).status).toBe("error");
  await setup.perform("disable-extension");
  expect(
    call.mock.calls.find(([message]) => message.member === "DisableExtension")?.[0].body,
  ).toEqual([GNOME_CAPTURE_UUID]);
  setup.close();
});

it("surfaces desktop rejection and disconnect as actionable failures", async () => {
  const { setup, bus } = fixture({ state: 2, version: 3, accepted: false });
  await expect(setup.perform("enable-extension")).rejects.toThrow("Sign out");
  bus.emit("error", new Error("Session bus disconnected"));
  expect(await setup.state()).toEqual({ status: "error", message: "Session bus disconnected" });
  setup.close();
});
