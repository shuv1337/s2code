/**
 * Thin HTTP MCP client for tools/call against the hub s2code /mcp endpoint.
 * Token comes from config/env only — never logged.
 */

export interface McpCallResult {
  readonly ok: boolean;
  readonly status: string;
  readonly content: unknown;
  readonly isError?: boolean;
}

export interface McpBridge {
  readonly callTool: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
}

export interface HttpMcpBridgeOptions {
  readonly mcpUrl: string;
  readonly mcpToken: string;
  readonly fetchImpl?: typeof fetch;
}

const jsonRpc = (method: string, params: Record<string, unknown>, id: number) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});

export const createHttpMcpBridge = (options: HttpMcpBridgeOptions): McpBridge => {
  const fetchImpl = options.fetchImpl ?? fetch;
  let nextId = 1;

  return {
    callTool: async (name, args) => {
      const id = nextId++;
      const body = jsonRpc("tools/call", { name, arguments: args }, id);
      const response = await fetchImpl(options.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${options.mcpToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          ok: false,
          status: `http_${response.status}`,
          content: null,
          isError: true,
        };
      }

      const payload = (await response.json()) as {
        readonly result?: {
          readonly content?: unknown;
          readonly isError?: boolean;
        };
        readonly error?: { readonly code?: number; readonly message?: string };
      };

      if (payload.error) {
        return {
          ok: false,
          status: `rpc_${payload.error.code ?? "error"}`,
          content: payload.error.message ?? null,
          isError: true,
        };
      }

      const isError = payload.result?.isError === true;
      return {
        ok: !isError,
        status: isError ? "tool_error" : "ok",
        content: payload.result?.content ?? null,
        isError,
      };
    },
  };
};

/** In-memory MCP for unit tests and text dry-run without a hub. */
export const createMockMcpBridge = (
  handler?: (name: string, args: Record<string, unknown>) => Promise<McpCallResult> | McpCallResult,
): McpBridge & { readonly calls: Array<{ name: string; args: Record<string, unknown> }> } => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (handler) return handler(name, args);
      return {
        ok: true,
        status: "ok",
        content: [{ type: "text", text: JSON.stringify({ mock: true, name }) }],
      };
    },
  };
};
