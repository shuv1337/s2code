import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveProductEnvironment,
  isProductRuntimeComplete,
  runtimeCompletionMarker,
  applyDevelopmentProductOverrides,
  applyProductEnvironment,
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
  it("bridges an old fork launcher child home without importing other upstream inputs", () => {
    const env = {
      T3CODE_HOME: "/custom-fork",
      T3CODE_PORT: "3773",
      T3_SERVICE_LAUNCHER_CONTEXT: "{}",
    };
    applyProductEnvironment(env);
    expect(env).toMatchObject({ T3CODE_HOME: "/custom-fork", SHUV2CODE_HOME: "/custom-fork" });
    expect(env).not.toHaveProperty("T3CODE_PORT");
    expect(resolveProductEnvironment({ ...env, SHUV2CODE_HOME: "/explicit" }).T3CODE_HOME).toBe(
      "/explicit",
    );
  });
  it("notices ignored upstream homes without breaking coexistence", () => {
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { T3CODE_HOME: "/upstream" };
      applyProductEnvironment(env);
      expect(env).not.toHaveProperty("T3CODE_HOME");
      expect(notice).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("ignoring T3CODE_HOME; use SHUV2CODE_HOME"),
      );
    } finally {
      notice.mockRestore();
    }
  });
  it("requires a separate product marker while retaining old-launcher completion compatibility", () => {
    const marker = runtimeCompletionMarker("1.2.3");
    expect(marker.trim() === "1.2.3").toBe(true); // Retained launcher's exact reader.
    expect(isProductRuntimeComplete(marker, "1.2.3", "shuv2code\n")).toBe(true);
    expect(isProductRuntimeComplete("1.2.3\r\n", "1.2.3", "shuv2code\r\n")).toBe(true);
    expect(isProductRuntimeComplete(marker, "1.2.3", "t3code")).toBe(false);
    expect(isProductRuntimeComplete(marker, "1.2.3", "")).toBe(false);
  });
});
