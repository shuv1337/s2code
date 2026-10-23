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

it("prefers a nonempty canonical marketing URL and otherwise accepts the legacy value", async () => {
  vi.stubEnv("SHUV2CODE_MARKETING_URL", "https://legacy.example");
  vi.stubEnv("S2CODE_MARKETING_URL", " https://canonical.example ");
  expect((await import("./astro.config.mjs")).default.site).toBe("https://canonical.example");
  vi.stubEnv("S2CODE_MARKETING_URL", "");
  vi.resetModules();
  expect((await import("./astro.config.mjs")).default.site).toBe("https://legacy.example");
});
