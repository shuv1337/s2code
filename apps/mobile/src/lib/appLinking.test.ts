import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "t3code://",
    "t3code:///",
    "t3code-dev://",
    "t3code-preview://",
    "s2code://",
    "s2code-dev://",
    "s2code-nightly://",
    "shuv2code://",
    "shuv2code-nightly://",
  ])("ignores scheme-only URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });

  it.each([
    "s2code://threads/env-1/thread-1",
    "s2code-nightly://threads/env-1/thread-1",
    "shuv2code://threads/env-1/thread-1",
    "t3code://threads/env-1/thread-1",
    "t3code://pair?pairingUrl=x",
    "t3code-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each(["t3code://expo-development-client/?url=x", "t3code://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );
});
