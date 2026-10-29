import { expect, it } from "vite-plus/test";

import { createHttpMcpBridge, createMockMcpBridge } from "./mcpBridge.ts";

it("mock mcp records calls", async () => {
  const mcp = createMockMcpBridge();
  const r = await mcp.callTool("t3_project_list", { environmentId: "e" });
  expect(r.ok).toBe(true);
  expect(mcp.calls).toHaveLength(1);
});

it("http mcp bridge posts tools/call and maps http errors", async () => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const mcp = createHttpMcpBridge({
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpToken: "tok",
    fetchImpl: (async (url, init) => {
      fetches.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 401 });
    }) as typeof fetch,
  });
  const r = await mcp.callTool("t3_thread_list", {});
  expect(r.ok).toBe(false);
  expect(r.status).toBe("http_401");
  expect(fetches).toHaveLength(1);
  const headers = fetches[0]!.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer tok");
  const body = JSON.parse(String(fetches[0]!.init.body)) as {
    method: string;
    params: { name: string };
  };
  expect(body.method).toBe("tools/call");
  expect(body.params.name).toBe("t3_thread_list");
});
