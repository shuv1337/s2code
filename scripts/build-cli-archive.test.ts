import { describe, expect, it } from "vite-plus/test";

import { macCodesignArgs } from "./build-cli-archive.ts";

describe("macCodesignArgs", () => {
  const identity = "Developer ID Application: Fixture (ABCDE12345)";
  const keychain = "/tmp/runner/t3-cli-signing.keychain-db";

  it("names the signing keychain for every Developer ID signature", () => {
    expect(
      macCodesignArgs({ identity, keychain, entitlements: undefined, target: "/stage/a.node" }),
    ).toEqual([
      "--force",
      "--sign",
      identity,
      "--keychain",
      keychain,
      "--options",
      "runtime",
      "--timestamp",
      "/stage/a.node",
    ]);
    expect(
      macCodesignArgs({ identity, keychain, entitlements: "/repo/cli.plist", target: "/stage/t3" }),
    ).toEqual([
      "--force",
      "--sign",
      identity,
      "--keychain",
      keychain,
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      "/repo/cli.plist",
      "/stage/t3",
    ]);
  });

  it("leaves the keychain to codesign's search list when none is configured", () => {
    expect(
      macCodesignArgs({ identity, keychain: undefined, entitlements: undefined, target: "/t3" }),
    ).not.toContain("--keychain");
    expect(
      macCodesignArgs({
        identity: "-",
        keychain: undefined,
        entitlements: undefined,
        target: "/t3",
      }),
    ).toEqual(["--force", "--sign", "-", "/t3"]);
  });
});
