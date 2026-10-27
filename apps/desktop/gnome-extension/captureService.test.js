import { expect, it } from "vite-plus/test";
import {
  CaptureService,
  CLIENT_NAMES,
  DBUS_NAME,
  DBUS_PATH,
  LEGACY_DBUS_NAME,
  isWaylandSession,
} from "./captureService.js";
import bundle from "./bundle.json" with { type: "json" };
import metadata from "./metadata.json" with { type: "json" };
import { PRODUCT_DBUS_PREFIX } from "../../../packages/shared/src/productIdentity.ts";
import { gnomeCaptureClientName } from "../src/snapShot/gnomeCaptureBundle.ts";
import {
  resolveLinuxDesktopId,
  resolveLinuxDesktopEntryName,
} from "../src/app/DesktopEarlyElectronStartup.ts";

it("ships only caller identities claimed by the real desktop entry resolver", () => {
  expect(metadata.uuid).toBe(bundle.uuid);
  expect(bundle.uuid).toBe("snap-shot@shuv1337.github.io");
  expect(bundle.dbusName).toBe(DBUS_NAME);
  expect(DBUS_NAME).toBe(`${PRODUCT_DBUS_PREFIX}.SnapShot`);
  expect(bundle.dbusPath).toBe(DBUS_PATH);
  expect(DBUS_PATH).toBe(`/${DBUS_NAME.replaceAll(".", "/")}`);
  const callers = [
    [false, "1.2.3"],
    [true, "1.2.3"],
    [false, "1.2.3-nightly.1"],
    [false, "1.2.3-preview.1"],
  ].map(([dev, version]) => {
    const appId = resolveLinuxDesktopId(dev, version);
    expect(resolveLinuxDesktopEntryName(dev, version)).toBe(`${appId}.desktop`);
    return appId;
  });
  expect(CLIENT_NAMES).toEqual([
    ...callers.map(gnomeCaptureClientName),
    ...callers.map((appId) => gnomeCaptureClientName(appId).replace(DBUS_NAME, LEGACY_DBUS_NAME)),
  ]);
  expect(new Set(callers.map(gnomeCaptureClientName)).size).toBe(4);
});

it.each([`${DBUS_NAME}.Client.nightly`, `${DBUS_NAME}.Client.preview`])(
  "rejects the unclaimed caller %s",
  async (client) => {
    const { service, snapshots } = fixture({
      getNameOwner: async (name) => (name === client ? ":1.23" : null),
    });
    await expect(service.capture(":1.23")).rejects.toThrow("Only S2Code");
    expect(snapshots()).toBe(0);
  },
);

it.each(["com.t3tools.T3Code.SnapShot", "com.t3tools.T3Code.Development.SnapShot"])(
  "rejects the upstream owner of %s without capturing pixels",
  async (upstream) => {
    const { service, snapshots } = fixture({
      getNameOwner: async (name) => (name === upstream ? ":1.23" : null),
    });
    await expect(service.capture(":1.23")).rejects.toThrow("Only S2Code");
    expect(snapshots()).toBe(0);
  },
);

it("supports GNOME 50 without the removed X11 API, rejecting older X11 sessions", () => {
  expect(isWaylandSession({})).toBe(true);
  expect(isWaylandSession({ is_wayland_compositor: () => true })).toBe(true);
  expect(isWaylandSession({ is_wayland_compositor: () => false })).toBe(false);
});

function fixture(overrides = {}) {
  let snapshots = 0;
  const options = {
    getNameOwner: async (name) => (name === CLIENT_NAMES[0] ? ":1.23" : null),
    isAvailable: () => true,
    takeSnapshot: async () => {
      snapshots++;
      return "pixels";
    },
    ...overrides,
  };
  return { service: new CaptureService(options), snapshots: () => snapshots };
}

it("rejects other clients before looking at the active window", async () => {
  const { service, snapshots } = fixture();
  await expect(service.capture(":1.99")).rejects.toThrow("Only S2Code");
  expect(snapshots()).toBe(0);
  expect(await service.capture(":1.23")).toBe("pixels");
});

it("rechecks the name owner on each capture", async () => {
  let owner = ":1.23";
  const { service } = fixture({ getNameOwner: async () => owner });
  expect(await service.capture(owner)).toBe("pixels");
  owner = ":1.24";
  await expect(service.capture(":1.23")).rejects.toThrow("Only S2Code");
});

it("rejects locked and non-Wayland sessions without taking a screenshot", async () => {
  const { service, snapshots } = fixture({ isAvailable: () => false });
  await expect(service.capture(":1.23")).rejects.toThrow("unavailable");
  expect(snapshots()).toBe(0);
});

it("does not start a screenshot if disabled during authorization", async () => {
  let authorize;
  const { service, snapshots } = fixture({
    getNameOwner: () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
  });
  const result = service.capture(":1.23");
  service.disable();
  authorize(":1.23");
  await expect(result).rejects.toThrow("unavailable");
  expect(snapshots()).toBe(0);
});

it.each(["lock", "disable"])(
  "does not return pixels after %s during capture",
  async (operation) => {
    let available = true;
    const { service } = fixture({
      isAvailable: () => available,
      takeSnapshot: async () => {
        if (operation === "disable") service.disable();
        else available = false;
        return "private pixels";
      },
    });
    await expect(service.capture(":1.23")).rejects.toThrow("unavailable");
  },
);

it("rejects concurrent requests and clears busy after a failed capture", async () => {
  let finish;
  const started = Promise.withResolvers();
  const { service } = fixture({
    takeSnapshot: () => {
      started.resolve();
      return new Promise((_, reject) => {
        finish = reject;
      });
    },
  });
  const first = service.capture(":1.23");
  await started.promise;
  await expect(service.capture(":1.23")).rejects.toThrow("already in progress");
  finish(new Error("gone"));
  await expect(first).rejects.toThrow("gone");
  await expect(service.capture(":1.99")).rejects.toThrow("Only S2Code");
});

it("prepares focus/effects only after pixels and identity have been captured", async () => {
  const events = [];
  const snapshot = { png: "pixels", metadata: "captured-window" };
  const { service } = fixture({
    getProcessId: async () => {
      events.push("caller-pid");
      return 42;
    },
    takeSnapshot: async () => {
      events.push("snapshot");
      return snapshot;
    },
    beginFeedback: (sender, pid, captured, options) => {
      expect([sender, pid, captured, options]).toEqual([
        ":1.23",
        42,
        snapshot,
        { flash: true, animate: true },
      ]);
      events.push("feedback");
      return true;
    },
  });
  expect(await service.capture(":1.23", { flash: true, animate: true })).toEqual({
    ...snapshot,
    animationStarted: true,
  });
  expect(events).toEqual(["caller-pid", "snapshot", "feedback"]);
});

it("does not create overlays or activate after the session locks during capture", async () => {
  let available = true;
  let feedback = 0;
  const { service } = fixture({
    getProcessId: async () => 42,
    isAvailable: () => available,
    takeSnapshot: async () => {
      available = false;
      return {};
    },
    beginFeedback: () => {
      feedback++;
    },
  });
  await expect(service.capture(":1.23", { flash: true, animate: true })).rejects.toThrow(
    "unavailable",
  );
  expect(feedback).toBe(0);
});
