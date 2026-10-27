import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";
import { useNpmReleasePublished } from "./npmRelease";

it("offers a version only when it is published in the fork npm package", async () => {
  const url = "https://registry.npmjs.org/@s2code%2fcli/1.2.3";
  const requests: string[] = [];
  using _fetch = stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const requested = input instanceof Request ? input.url : String(input);
    requests.push(requested);
    return requested === url
      ? Response.json({ version: "1.2.3" })
      : new Response(null, { status: 404 });
  });
  const registry = AtomRegistry.make();
  function Probe() {
    const published = useNpmReleasePublished("1.2.3");
    return <output>{String(published)}</output>;
  }
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
    { router: false },
  );
  await expect.element(screen.getByText("true")).toBeInTheDocument();
  expect(requests).toEqual([url]);
});
