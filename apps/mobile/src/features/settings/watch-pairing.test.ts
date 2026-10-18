import { describe, expect, it } from "vite-plus/test";

import { watchPairingMode } from "./watch-pairing";

describe("watchPairingMode", () => {
  it.each([
    "https://desktop.tailnet.ts.net",
    "http://localhost:4983",
    "http://127.0.0.1",
    "http://169.254.2.3",
    "http://10.2.3.4",
    "http://172.20.1.2",
    "http://192.168.1.8",
    "http://[::1]",
    "http://[fd12::4]",
    "http://[fe80::4]",
  ])("routes private origin %s through the iPhone", (origin) => {
    expect(watchPairingMode(origin)).toBe("phone");
  });

  it.each([
    "https://app.t3.codes",
    "https://fc.example.com",
    "https://fd.example.com",
    "not a URL",
  ])("leaves public origin %s on automatic routing", (origin) => {
    expect(watchPairingMode(origin)).toBe("automatic");
  });
});
