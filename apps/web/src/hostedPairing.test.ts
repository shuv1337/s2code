import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  it("keeps direct and Tailscale pairing on the destination when hosted is unavailable", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "");
    const url = new URL(
      buildHostedPairingUrl({ host: "https://machine.tailnet.ts.net", token: "fixture" }),
    );
    expect(url.origin).toBe("https://machine.tailnet.ts.net");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.has("host")).toBe(false);
    expect(url.hash).toBe("#token=fixture");
    expect(() => buildHostedChannelSelectionUrl({ channel: "nightly" })).toThrow("unavailable");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.t3.codes/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.fork.test");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }),
    );

    expect(url.origin).toBe("https://preview.fork.test");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });
});
