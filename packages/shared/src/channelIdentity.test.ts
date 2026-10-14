import { expect, it } from "vite-plus/test";
import { resolveChannelIdentity } from "./channelIdentity.ts";

it("keeps stable identity and partitions every channel-owned namespace", () => {
  const stable = resolveChannelIdentity("1.2.3");
  expect(stable).toMatchObject({
    homeDirectory: ".shuv2code-v2",
    profileDirectory: "shuv2code-v2",
    scheme: "shuv2code",
    appId: "dev.shuv.shuv2code",
    serviceName: "shuv2code-v2",
    serviceLabel: "dev.shuv.shuv2code.v2.service",
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
