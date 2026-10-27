import { describe, expect, it, vi } from "vite-plus/test";

import { resolveCloudPublicConfig } from "./publicConfig";
const key = `pk_test_${btoa("clerk.fork.test$")}`;

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("does not expose upstream hosted values to the runtime", () => {
    const config = resolveCloudPublicConfig({
      clerk: { publishableKey: `pk_live_${btoa("clerk.t3.codes$")}`, jwtTemplate: "relay" },
      relay: { url: "https://relay.t3.codes" },
    });
    expect(config.clerk.publishableKey).toBeNull();
    expect(config.relay.url).toBeNull();
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: key, jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: key,
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });
});
