import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import Constants from "expo-constants";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";
const key = `pk_test_${btoa("clerk.fork.test$")}`;

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

afterEach(() => {
  Constants.expoConfig!.extra = {};
});

describe("resolveCloudPublicConfig", () => {
  it("accepts a fork Clerk development key, relay URL, and JWT template", () => {
    const forkKey = `pk_test_${btoa("example-fork.clerk.accounts.dev$")}`;
    const extra = {
      clerk: { publishableKey: forkKey, jwtTemplate: "t3-relay" },
      relay: { url: "https://relay.slopcartel.dev" },
    };
    expect(resolveCloudPublicConfig(extra)).toEqual({
      clerk: {
        publishableKey: forkKey,
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: "https://relay.slopcartel.dev",
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
    Constants.expoConfig!.extra = extra;
    expect(hasCloudPublicConfig()).toBe(true);
  });

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
