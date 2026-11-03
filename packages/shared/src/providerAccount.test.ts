import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderAuth } from "@t3tools/contracts";

import { providerAccountKey } from "./providerAccount.ts";

const cursor = ProviderDriverKind.make("cursor");
const signedIn = (auth: Partial<ServerProviderAuth> = {}, driver = cursor) => ({
  driver,
  auth: { status: "authenticated" as const, email: "dev@example.test", ...auth },
});

describe("providerAccountKey", () => {
  it("matches the same account however its email is written", () => {
    const key = providerAccountKey(signedIn());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(providerAccountKey(signedIn({ email: "  Dev@Example.TEST " }))).toBe(key);
    expect(providerAccountKey(signedIn({ label: "Work", type: "team" }))).toBe(key);
    const otherInstance = { ...signedIn(), instanceId: "cursor_pool_2", displayName: "Cursor-2" };
    expect(providerAccountKey(otherInstance)).toBe(key);
  });

  it("separates accounts by driver, email, and workspace", () => {
    const keys = [
      signedIn(),
      signedIn({}, ProviderDriverKind.make("codex")),
      signedIn({ email: "other@example.test" }),
      signedIn({ workspaceId: "team-a" }),
      signedIn({ workspaceId: "team-b" }),
    ].map(providerAccountKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each([
    ["unauthenticated", signedIn({ status: "unauthenticated" })],
    ["unknown", signedIn({ status: "unknown" })],
    ["no email", { driver: cursor, auth: { status: "authenticated" as const } }],
    ["blank email", signedIn({ email: "   " })],
  ])("has no key when %s", (_name, provider) => {
    expect(providerAccountKey(provider)).toBeUndefined();
  });
});
