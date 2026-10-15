import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each([
    "t3code",
    "t3code-dev",
    "shuv2code",
    "shuv2code-dev",
    "shuv2code-nightly",
    "shuv2code-preview",
  ])("returns to %s Welcome and the selected settings instance", (scheme) => {
    expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
      `${scheme}://app/welcome#agents:machine-id`,
    );
    expect(
      providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
    ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
  });
  it.each(["http://localhost:3773", "http://127.0.0.1:3773", "http://[::1]:3773"])(
    "allows local return to %s without hosted config",
    (origin) => {
      expect(providerAuthReturnUrl(`${origin}/settings?code=secret`)).toBe(`${origin}/settings`);
    },
  );
  it("allows only the configured fork hosted origin", () => {
    const target = "https://app.fork.example/welcome#agents:machine-id";
    expect(providerAuthReturnUrl(target)).toBeUndefined();
    expect(providerAuthReturnUrl(target, "https://app.fork.example")).toBe(target);
    expect(providerAuthReturnUrl(target, "https://other.fork.example")).toBeUndefined();
    expect(
      providerAuthReturnUrl("https://app.t3.codes/welcome", "https://app.t3.codes"),
    ).toBeUndefined();
    expect(providerAuthReturnUrl("https://app.t3.codes/welcome")).toBeUndefined();
    expect(
      providerAuthReturnUrl("https://child.app.fork.example/welcome", "https://app.fork.example"),
    ).toBeUndefined();
  });
  it.each([
    "t3code://attacker/welcome",
    "t3code://app:123/welcome",
    "t3code://app/auth/callback",
    "t3code://user@ app/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
    "file:///welcome",
    "javascript:alert(1)",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
