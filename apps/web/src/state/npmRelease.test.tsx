import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useNpmReleasePublished } from "./npmRelease";

afterEach(() => vi.unstubAllGlobals());

it("offers a version only when it is published in the fork npm package", async () => {
  const url = "https://registry.npmjs.org/s2code/1.2.3";
  const requests: string[] = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const requested = input instanceof Request ? input.url : String(input);
    requests.push(requested);
    return requested === url
      ? Response.json({ version: "1.2.3" })
      : new Response(null, { status: 404 });
  });
  const registry = AtomRegistry.make();
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    const published = useNpmReleasePublished("1.2.3");
    return <output>{String(published)}</output>;
  }
  try {
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      );
    });
    expect(requests).toEqual([url]);
    expect(renderer?.root.findByType("output").children).toEqual(["true"]);
  } finally {
    await act(async () => renderer?.unmount());
    registry.dispose();
  }
});
