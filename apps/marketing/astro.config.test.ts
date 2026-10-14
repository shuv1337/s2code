import { afterEach, expect, it, vi } from "vite-plus/test";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("uses only the fork marketing URL", async () => {
  vi.stubEnv("T3CODE_MARKETING_URL", "https://upstream.invalid");
  vi.stubEnv("SHUV2CODE_MARKETING_URL", " https://fork.example ");
  vi.resetModules();
  expect((await import("./astro.config.mjs")).default.site).toBe("https://fork.example");
  vi.stubEnv("SHUV2CODE_MARKETING_URL", "");
  vi.resetModules();
  expect((await import("./astro.config.mjs")).default.site).toBeUndefined();
});
