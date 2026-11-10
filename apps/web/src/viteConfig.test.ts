import { expect, it, vi } from "vite-plus/test";

it("does not proxy browser fixtures to an inherited agent server", async () => {
  vi.stubEnv("VITEST", "true");
  vi.stubEnv("T3CODE_PORT", "9");
  vi.stubEnv("S2CODE_PORT", "9");
  vi.stubEnv("SHUV2CODE_PORT", "9");
  try {
    const { default: config } = await import("../vite.config");
    if (typeof config !== "function") throw new Error("Expected a Vite config function");
    const resolved = await config({ command: "serve", mode: "test" });
    expect(resolved.server?.proxy).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});
