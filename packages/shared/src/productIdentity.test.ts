import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveProductEnvironment,
  isProductRuntimeComplete,
  runtimeCompletionMarker,
  applyDevelopmentProductOverrides,
  applyProductEnvironment,
  resolveProductDownload,
  isProductIdentity,
} from "./productIdentity.ts";

it("routes desktop downloads only to the fork and makes mobile distribution explicitly unavailable", () => {
  expect(resolveProductDownload(false)).toEqual({
    url: "https://github.com/shuv1337/shuv2code/releases",
    label: "Fork releases",
  });
  expect(resolveProductDownload(true)).toEqual({
    url: null,
    label: "Fork mobile apps are not available yet.",
  });
});

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
    ).toEqual({ S2CODE_HOME: "/fork", SHUV2CODE_HOME: "/fork", T3CODE_HOME: "/fork" });
  });
  it.each(["arbitrary-context", "{}", '{"version":"1.2.3"}'])(
    "never adopts inherited upstream homes through launcher context %s",
    (context) => {
      const notice = vi.spyOn(console, "error").mockImplementation(() => {});
      const env = {
        T3CODE_HOME: "/upstream/custom-home",
        T3CODE_PORT: "3773",
        T3_SERVICE_LAUNCHER_CONTEXT: context,
      };
      try {
        applyProductEnvironment(env);
        expect(env).not.toHaveProperty("T3CODE_HOME");
        expect(env).not.toHaveProperty("SHUV2CODE_HOME");
        expect(env).not.toHaveProperty("T3CODE_PORT");
        expect(notice).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("ignoring T3CODE_HOME; use S2CODE_HOME"),
        );
        expect(resolveProductEnvironment({ ...env, SHUV2CODE_HOME: "/explicit" }).T3CODE_HOME).toBe(
          "/explicit",
        );
      } finally {
        notice.mockRestore();
      }
    },
  );
  it("notices ignored upstream homes without breaking coexistence", () => {
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { T3CODE_HOME: "/upstream" };
      applyProductEnvironment(env);
      expect(env).not.toHaveProperty("T3CODE_HOME");
      expect(notice).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("ignoring T3CODE_HOME; use S2CODE_HOME"),
      );
    } finally {
      notice.mockRestore();
    }
  });
  it("keeps an explicit fork home authoritative under inherited launcher context without repeated notices", () => {
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = {
        T3CODE_HOME: "/upstream/custom-home",
        SHUV2CODE_HOME: "/fork",
        T3_SERVICE_LAUNCHER_CONTEXT: "arbitrary-context",
      };
      applyProductEnvironment(env);
      applyProductEnvironment(env);
      expect(env.T3CODE_HOME).toBe("/fork");
      expect(env.SHUV2CODE_HOME).toBe("/fork");
      expect(notice).toHaveBeenCalledTimes(1);
    } finally {
      notice.mockRestore();
    }
  });
  it("requires a separate product marker while retaining old-launcher completion compatibility", () => {
    const marker = runtimeCompletionMarker("1.2.3");
    expect(marker.trim() === "1.2.3").toBe(true); // Retained launcher's exact reader.
    expect(isProductRuntimeComplete(marker, "1.2.3", "shuv2code\n")).toBe(true);
    expect(isProductRuntimeComplete(marker, "1.2.3", "s2code\n")).toBe(true);
    expect(isProductRuntimeComplete(marker, "1.2.4", "s2code\n")).toBe(false);
    expect(isProductRuntimeComplete("1.2.3\r\n", "1.2.3", "shuv2code\r\n")).toBe(true);
    expect(isProductRuntimeComplete(marker, "1.2.3", "t3code")).toBe(false);
    expect(isProductRuntimeComplete(marker, "1.2.3", "")).toBe(false);
  });
  it("prefers canonical settings over legacy aliases across all process boundaries", () => {
    const resolved = resolveProductEnvironment({
      S2CODE_HOME: " /new-home ",
      SHUV2CODE_HOME: "/old-home",
      T3CODE_HOME: "/upstream",
      S2CODE_PORT: "5773",
      SHUV2CODE_PORT: "4773",
      s2code_otlp_headers: "canonical-observability",
      shuv2code_otlp_headers: "legacy-observability",
      SHUV2CODE_HOST: "127.0.0.1",
    });
    expect(resolved).toEqual({
      S2CODE_HOME: "/new-home",
      SHUV2CODE_HOME: "/new-home",
      T3CODE_HOME: "/new-home",
      S2CODE_PORT: "5773",
      SHUV2CODE_PORT: "5773",
      T3CODE_PORT: "5773",
      S2CODE_HOST: "127.0.0.1",
      SHUV2CODE_HOST: "127.0.0.1",
      T3CODE_HOST: "127.0.0.1",
      S2CODE_OTLP_HEADERS: "canonical-observability",
      SHUV2CODE_OTLP_HEADERS: "canonical-observability",
      T3CODE_OTLP_HEADERS: "canonical-observability",
    });
    expect(resolveProductEnvironment(resolved)).toEqual(resolved);
  });
  it("treats blank canonical inputs as unset while keeping nonblank legacy settings", () => {
    expect(resolveProductEnvironment({ S2CODE_HOME: "  ", SHUV2CODE_HOME: "/old-home" })).toEqual({
      S2CODE_HOME: "/old-home",
      SHUV2CODE_HOME: "/old-home",
      T3CODE_HOME: "/old-home",
    });
    expect(
      resolveProductEnvironment({ S2CODE_HOME: "", SHUV2CODE_HOME: " ", T3CODE_HOME: "/upstream" }),
    ).toEqual({});
  });
  it("normalizes managed development overrides without replacing the worktree home", () => {
    const env: Record<string, string | undefined> = {
      T3CODE_HOME: "/worktree/.t3",
      S2CODE_PORT: "5773",
      SHUV2CODE_PORT: "4773",
    };
    applyDevelopmentProductOverrides(env);
    expect(env).toMatchObject({
      T3CODE_HOME: "/worktree/.t3",
      S2CODE_PORT: "5773",
      SHUV2CODE_PORT: "5773",
      T3CODE_PORT: "5773",
    });
    expect(env.S2CODE_HOME).toBeUndefined();
  });
  it("removes mixed-case development aliases before writing normalized values", () => {
    const env: Record<string, string | undefined> = {
      T3CODE_HOME: "/worktree/.t3",
      s2code_port: "5773",
      Shuv2Code_Port: "4773",
      t3code_port: "3773",
    };
    applyDevelopmentProductOverrides(env);
    expect(env).toEqual({
      T3CODE_HOME: "/worktree/.t3",
      S2CODE_PORT: "5773",
      SHUV2CODE_PORT: "5773",
      T3CODE_PORT: "5773",
    });
  });
  it("refuses upstream import under either public name", () => {
    expect(() => resolveProductEnvironment({ S2CODE_IMPORT_UPSTREAM: "1" })).toThrow(
      "Upstream import is not supported",
    );
  });
  it.each(["s2", "shuv", "shuv2code-v1", "t3", "t3code", "s2code-other"])(
    "never accepts partial or foreign ownership %s",
    (identity) => {
      expect(isProductIdentity(identity)).toBe(false);
    },
  );
});
