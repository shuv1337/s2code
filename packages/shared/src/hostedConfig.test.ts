import { describe, expect, it } from "vite-plus/test";
import {
  forkHostedOrigin,
  forkClerkPublishableKey,
  UPSTREAM_HOSTED_DOMAINS,
} from "./hostedConfig.ts";

describe("fork hosted ownership", () => {
  it.each(UPSTREAM_HOSTED_DOMAINS)(
    "rejects upstream %s and its subdomains with DNS boundaries",
    (root) => {
      for (const host of [root, `relay.${root}`, `CLERK.${root.toUpperCase()}.`]) {
        expect(forkHostedOrigin(`https://${host}`)).toBeNull();
        expect(forkClerkPublishableKey(`pk_live_${btoa(`${host}$`)}`)).toBeNull();
      }
      expect(forkHostedOrigin(`https://${root}.fork.test`)).not.toBeNull();
    },
  );
  it("defaults to unconfigured without blocking explicit loopback development", () => {
    expect(forkHostedOrigin(undefined)).toBeNull();
    expect(forkHostedOrigin("http://localhost:3000")).toBeNull();
    expect(forkHostedOrigin("http://localhost:3000", true)).toBe("http://localhost:3000");
    expect(forkHostedOrigin("https://user:secret@fork.test")).toBeNull();
    expect(forkHostedOrigin("https://fork.test/path")).toBeNull();
    expect(forkClerkPublishableKey("pk_test_example")).toBeNull();
  });
});
