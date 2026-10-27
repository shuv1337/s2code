import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { npmReleasePackageAtom, npmReleasePublishedAtom } from "./npmRelease";

const version = "0.0.46-nightly.20261012.3021";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck() {
  const atom = npmReleasePublishedAtom(version);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("npmReleasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("checks npm without tracing headers, so the browser skips the preflight npm rejects", async () => {
    fetchMock.mockImplementation(async () => Response.json({ version }));

    const result = await settledCheck();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(`https://registry.npmjs.org/@s2code%2fcli/${version}`);
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  it.each([404, 503, "network"] as const)(
    "falls back to the legacy package after canonical lookup returns %s",
    async (failure) => {
      fetchMock.mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.includes("/@s2code%2fcli/")) return Response.json({ version });
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response(null, { status: failure });
      });
      const registry = AtomRegistry.make();
      const atom = npmReleasePackageAtom(version);
      const unmount = registry.mount(atom);
      try {
        await vi.waitFor(() =>
          expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toBe("shuv2code"),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        unmount();
        registry.dispose();
      }
    },
  );

  it("reports a version npm does not have as unpublished", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));

    const result = await settledCheck();

    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => true)).toBe(false);
  });

  it("returns no package when both registry checks fail", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck();

    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });
});
