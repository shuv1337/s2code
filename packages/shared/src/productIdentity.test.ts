import { describe, expect, it } from "vite-plus/test";
import {
  resolveProductEnvironment,
  isProductRuntimeComplete,
  runtimeCompletionMarker,
  applyDevelopmentProductOverrides,
} from "./productIdentity.ts";

describe("fork public configuration", () => {
  it("preserves explicit managed dev inputs while preferring fork overrides", () => {
    const env = { T3CODE_HOME: "/worktree/.t3", T3CODE_PORT: "3773", SHUV2CODE_PORT: "4773" };
    applyDevelopmentProductOverrides(env);
    expect(env.T3CODE_HOME).toBe("/worktree/.t3");
    expect(env.T3CODE_PORT).toBe("4773");
  });
  it("ignores inherited upstream settings while keeping dev and IPC inputs", () => {
    expect(
      resolveProductEnvironment({
        T3CODE_HOME: "/upstream",
        T3CODE_PORT: "3773",
        T3CODE_RELEASE_BASE_URL: "https://upstream",
        T3CODE_DEV_AUTH_TOKEN: "development-token",
        T3CODE_BOOTSTRAP_FD: "3",
      }),
    ).toEqual({ T3CODE_DEV_AUTH_TOKEN: "development-token", T3CODE_BOOTSTRAP_FD: "3" });
  });
  it("assigns explicit fork settings to internal adapters and is idempotent", () => {
    const input = {
      SHUV2CODE_HOME: "/fork",
      SHUV2CODE_PORT: "4773",
      SHUV2CODE_RELEASE_BASE_URL: "https://fork",
      T3CODE_HOME: "/upstream",
    };
    const resolved = resolveProductEnvironment(input);
    expect(resolved).toMatchObject({
      T3CODE_HOME: "/fork",
      T3CODE_PORT: "4773",
      T3CODE_RELEASE_BASE_URL: "https://fork",
    });
    expect(resolveProductEnvironment(resolved)).toEqual(resolved);
    expect(input.T3CODE_HOME).toBe("/upstream");
  });
  it("does not offer an in-place upstream compatibility mode", () => {
    expect(() => resolveProductEnvironment({ SHUV2CODE_IMPORT_UPSTREAM: "1" })).toThrow(
      "Upstream import is not supported",
    );
  });
  it("does not reintroduce differently cased Windows environment names", () => {
    expect(
      resolveProductEnvironment({
        t3code_home: "/upstream",
        T3Code_Port: "3773",
        shuv2code_home: "/fork",
      }),
    ).toEqual({ SHUV2CODE_HOME: "/fork", T3CODE_HOME: "/fork" });
  });
  it("requires product identity on custom-path caches, with a narrow legacy migration", () => {
    expect(isProductRuntimeComplete(runtimeCompletionMarker("1.2.3"), "1.2.3", false)).toBe(true);
    expect(isProductRuntimeComplete("shuv2code\r\n1.2.3\r\n", "1.2.3", false)).toBe(true);
    expect(isProductRuntimeComplete("t3code\n1.2.3\n", "1.2.3", true)).toBe(false);
    expect(isProductRuntimeComplete("1.2.3", "1.2.3", false)).toBe(false);
    expect(isProductRuntimeComplete("1.2.3", "1.2.3", true)).toBe(true);
  });
});
