import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchLatestRelease } from "./releases";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLatestRelease", () => {
  it.each([
    ["stable", "https://api.github.com/repos/shuv1337/s2code/releases/latest"],
    ["nightly", "https://api.github.com/repos/shuv1337/s2code/releases?per_page=10"],
  ] as const)(
    "rejects a GitHub API error response for %s instead of returning it as a release",
    async (channel, url) => {
      vi.stubGlobal("sessionStorage", { getItem: () => null });
      const fetch = vi.fn(async () =>
        Response.json({ message: "API rate limit exceeded" }, { status: 403 }),
      );
      vi.stubGlobal("fetch", fetch);

      await expect(fetchLatestRelease(channel)).rejects.toThrow("403");
      expect(fetch).toHaveBeenCalledWith(url);
    },
  );
});
