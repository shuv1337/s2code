import { expect, it } from "vite-plus/test";
import {
  resolveChannelIdentity,
  resolveLegacyChannelIdentity,
  isSameInstallationChannel,
} from "./channelIdentity.ts";

it("keeps stable identity and partitions every channel-owned namespace", () => {
  const stable = resolveChannelIdentity("1.2.3");
  expect(stable).toMatchObject({
    homeDirectory: ".s2code-v2",
    profileDirectory: "shuv2code-v2",
    scheme: "s2code",
    appId: "dev.shuv.shuv2code",
    serviceName: "s2code-v2",
    serviceLabel: "dev.shuv.s2code.v2.service",
    updateChannel: "latest",
  });
  const nightly = resolveChannelIdentity("1.2.3-nightly.20261014.1");
  const preview = resolveChannelIdentity("1.2.3-preview.20261014.1");
  expect(nightly.updateChannel).toBe("nightly");
  expect(preview.updateChannel).toBeNull();
  for (const field of [
    "homeDirectory",
    "profileDirectory",
    "scheme",
    "appId",
    "serviceName",
    "serviceLabel",
    "executableName",
  ] as const)
    expect(new Set([stable[field], nightly[field], preview[field]]).size).toBe(3);
  expect(resolveChannelIdentity("1.2.3-pr.275.1")).toEqual(preview);
  expect(resolveChannelIdentity("1.2.3-alpha.1")).toEqual(stable);
  expect(resolveChannelIdentity("1.2.3-foo-preview.1")).toEqual(stable);
});
it.each(["1.2.3", "1.2.3-nightly.20261014.1", "1.2.3-preview.20261014.1"])(
  "retains native app and update identities while exposing legacy installation names for %s",
  (version) => {
    const current = resolveChannelIdentity(version);
    const legacy = resolveLegacyChannelIdentity(version);
    expect(current.appId).toBe(legacy.appId);
    expect(current.profileDirectory).toBe(legacy.profileDirectory);
    expect(current.updateChannel).toBe(legacy.updateChannel);
    for (const field of [
      "homeDirectory",
      "scheme",
      "executableName",
      "serviceName",
      "serviceLabel",
    ] as const)
      expect(current[field]).toBe(legacy[field].replace("shuv2code", "s2code"));
  },
);
it("permits updates within a channel but never crosses installation ownership", () => {
  expect(isSameInstallationChannel("1.2.3", "1.3.0")).toBe(true);
  expect(isSameInstallationChannel("1.2.3-nightly.20261014.1", "1.3.0-nightly.20261015.1")).toBe(
    true,
  );
  expect(isSameInstallationChannel("1.2.3-preview.20261014.1", "1.3.0-pr.275.1")).toBe(true);
  expect(isSameInstallationChannel("1.2.3", "1.3.0-nightly.20261014.1")).toBe(false);
});
