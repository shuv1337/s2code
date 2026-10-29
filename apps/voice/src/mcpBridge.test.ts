import { expect, it } from "vite-plus/test";

import {
  createHttpMcpBridge,
  createMockMcpBridge,
  createVoiceMcpBridge,
  MissingMcpUrlError,
} from "./mcpBridge.ts";

it("mock mcp records calls", async () => {
  const mcp = createMockMcpBridge();
  const r = await mcp.callTool("t3_project_list", { environmentId: "e" });
  expect(r.ok).toBe(true);
  expect(mcp.calls).toHaveLength(1);
});

type Recorded = {
  method: string;
  mcpSessionId: string | null;
  authorization: string | null;
  body: unknown;
};

const createFakeMcpServer = (options?: {
  readonly sessionId?: string;
  readonly expireFirstToolsCall?: boolean;
}) => {
  const sessionId = options?.sessionId ?? "sess-test-1";
  let activeSession: string | null = null;
  let toolsCalls = 0;
  const recorded: Recorded[] = [];

  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const headersIn = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const method = typeof body.method === "string" ? body.method : String(init?.method ?? "POST");
    const mcpSessionId = headersIn.get("mcp-session-id");
    const authorization = headersIn.get("authorization");
    recorded.push({ method, mcpSessionId, authorization, body });

    if (method === "initialize") {
      activeSession = sessionId;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
      });
    }

    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (method === "tools/call") {
      toolsCalls += 1;
      if (!mcpSessionId || mcpSessionId !== activeSession) {
        return new Response(JSON.stringify({ error: "missing session" }), { status: 400 });
      }
      if (options?.expireFirstToolsCall && toolsCalls === 1) {
        activeSession = null;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "Session expired" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      const params = body.params as { name?: string; arguments?: Record<string, unknown> };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ tool: params.name, args: params.arguments }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(null, { status: 500 });
  }) as typeof fetch;

  return { fetchImpl, recorded, getActiveSession: () => activeSession };
};

it("http mcp bridge handshakes then posts tools/call with Mcp-Session-Id", async () => {
  const server = createFakeMcpServer();
  const mcp = createHttpMcpBridge({
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpToken: "tok",
    fetchImpl: server.fetchImpl,
  });

  const r = await mcp.callTool("t3_thread_list", { environmentId: "e1" });
  expect(r.ok).toBe(true);
  expect(r.status).toBe("ok");

  expect(server.recorded.map((x) => x.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  expect(server.recorded[0]!.mcpSessionId).toBeNull();
  expect(server.recorded[1]!.mcpSessionId).toBe("sess-test-1");
  expect(server.recorded[2]!.mcpSessionId).toBe("sess-test-1");
  expect(server.recorded.every((x) => x.authorization === "Bearer tok")).toBe(true);

  const toolsBody = server.recorded[2]!.body as {
    method: string;
    params: { name: string; arguments: Record<string, unknown> };
  };
  expect(toolsBody.params.name).toBe("t3_thread_list");
  expect(toolsBody.params.arguments).toEqual({ environmentId: "e1" });

  // Second call reuses session — no second initialize.
  const r2 = await mcp.callTool("t3_project_list", {});
  expect(r2.ok).toBe(true);
  expect(server.recorded.map((x) => x.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/call",
    "tools/call",
  ]);
});

it("http mcp bridge re-initializes once after session 404", async () => {
  const server = createFakeMcpServer({ expireFirstToolsCall: true });
  const mcp = createHttpMcpBridge({
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpToken: "tok",
    fetchImpl: server.fetchImpl,
  });

  const r = await mcp.callTool("t3_project_list", {});
  expect(r.ok).toBe(true);
  expect(r.status).toBe("ok");

  expect(server.recorded.map((x) => x.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/call", // 404 session lost
    "initialize",
    "notifications/initialized",
    "tools/call", // retry
  ]);
});

it("does not replay a tools/call when the error text mentions a session", async () => {
  let toolCalls = 0;
  const mcp = createHttpMcpBridge({
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpToken: "tok",
    fetchImpl: (async (_url, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { method?: string }) : {};
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "s" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      toolCalls += 1;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: "Session expired" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  const result = await mcp.callTool("t3_thread_list", {});
  expect(result.ok).toBe(false);
  expect(toolCalls).toBe(1);
});

it("http mcp bridge maps auth failures after handshake", async () => {
  let n = 0;
  const mcp = createHttpMcpBridge({
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpToken: "tok",
    fetchImpl: (async (_url, init) => {
      n += 1;
      const body = init?.body ? (JSON.parse(String(init.body)) as { method?: string }) : {};
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "s" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 401 });
    }) as typeof fetch,
  });
  const r = await mcp.callTool("t3_thread_list", {});
  expect(r.ok).toBe(false);
  expect(r.status).toBe("http_401");
  expect(n).toBe(3);
});

it("http mcp bridge lists tool input schemas", async () => {
  const mcp = createHttpMcpBridge({
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpToken: "tok",
    fetchImpl: (async (_url, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { method?: string }) : {};
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "s" },
        });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [
              {
                name: "t3_environment_links",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
              {
                name: "t3_thread_list",
                inputSchema: { properties: { projectId: { type: "string" } } },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  const tools = await mcp.listTools();
  expect(tools.find((tool) => tool.name === "t3_environment_links")?.inputSchema).toEqual({
    properties: {},
    additionalProperties: false,
  });
  expect(
    tools.find((tool) => tool.name === "t3_thread_list")?.inputSchema?.properties,
  ).toHaveProperty("projectId");
});

it("createVoiceMcpBridge fails loudly when mcpUrl is empty without --mock-mcp", () => {
  expect(() =>
    createVoiceMcpBridge({
      mcpUrl: "",
      mcpToken: "tok",
      useMockMcp: false,
    }),
  ).toThrow(MissingMcpUrlError);
  expect(() =>
    createVoiceMcpBridge({
      mcpUrl: "   ",
      mcpToken: "tok",
      useMockMcp: false,
    }),
  ).toThrow(/Refusing silent mock fallback/);
});

it("createVoiceMcpBridge uses mock only when useMockMcp is true", async () => {
  const mcp = createVoiceMcpBridge({
    mcpUrl: "",
    mcpToken: "",
    useMockMcp: true,
  });
  const r = await mcp.callTool("t3_project_list", {});
  expect(r.ok).toBe(true);
  expect(typeof createMockMcpBridge().callTool).toBe("function");
});
