/**
 * Thin HTTP MCP client for tools/call against the hub s2code /mcp endpoint.
 * Performs the streamable-HTTP session handshake (initialize → Mcp-Session-Id →
 * notifications/initialized) and re-initializes once on 404 / expired session.
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

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "s2-voice", version: "0" } as const;

const jsonRpc = (method: string, params: Record<string, unknown>, id: number) => ({
  jsonrpc: "2.0" as const,
  id,
  method,
  params,
});

const sessionHeader = (headers: Headers): string | null =>
  headers.get("mcp-session-id") ?? headers.get("Mcp-Session-Id");

const parseJsonRpcBody = async (response: Response): Promise<unknown> => {
  const ctype = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text.trim()) return null;
  if (ctype.includes("text/event-stream")) {
    const lines = text.split("\n").filter((line) => line.startsWith("data: "));
    const last = lines.at(-1)?.slice(6) ?? text;
    try {
      return JSON.parse(last) as unknown;
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const isSessionLost = (response: Response, payload: unknown): boolean => {
  if (response.status === 404) return true;
  if (!payload || typeof payload !== "object") return false;
  const error = (payload as { error?: { message?: unknown } }).error;
  const message = typeof error?.message === "string" ? error.message : "";
  if (!message) return false;
  return /session/i.test(message) && /(expired|not found|unknown|invalid)/i.test(message);
};

type JsonRpcPayload = {
  readonly result?: {
    readonly content?: unknown;
    readonly isError?: boolean;
  };
  readonly error?: { readonly code?: number; readonly message?: string };
};

const mapPayload = (payload: JsonRpcPayload | null): McpCallResult => {
  if (!payload) {
    return { ok: false, status: "bad_response", content: null, isError: true };
  }
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
};

export const createHttpMcpBridge = (options: HttpMcpBridgeOptions): McpBridge => {
  const fetchImpl = options.fetchImpl ?? fetch;
  let nextId = 1;
  let sessionId: string | null = null;

  const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${options.mcpToken}`,
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
      headers["mcp-protocol-version"] = PROTOCOL_VERSION;
    }
    return headers;
  };

  const ensureSession = async (): Promise<McpCallResult | null> => {
    if (sessionId) return null;

    const initResponse = await fetchImpl(options.mcpUrl, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(
        jsonRpc(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
          nextId++,
        ),
      ),
    });

    const sid = sessionHeader(initResponse.headers);
    // Drain body even on failure so the connection can reuse.
    await parseJsonRpcBody(initResponse);

    if (!initResponse.ok || !sid) {
      return {
        ok: false,
        status: `mcp_init_http_${initResponse.status}`,
        content: null,
        isError: true,
      };
    }

    sessionId = sid;

    await fetchImpl(options.mcpUrl, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });

    return null;
  };

  const postToolsCall = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ response: Response; payload: JsonRpcPayload | null }> => {
    const response = await fetchImpl(options.mcpUrl, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(jsonRpc("tools/call", { name, arguments: args }, nextId++)),
    });
    const payload = (await parseJsonRpcBody(response)) as JsonRpcPayload | null;
    return { response, payload };
  };

  return {
    callTool: async (name, args) => {
      const initError = await ensureSession();
      if (initError) return initError;

      let { response, payload } = await postToolsCall(name, args);

      if (isSessionLost(response, payload)) {
        sessionId = null;
        const reinitError = await ensureSession();
        if (reinitError) return reinitError;
        ({ response, payload } = await postToolsCall(name, args));
      }

      if (!response.ok) {
        return {
          ok: false,
          status: `http_${response.status}`,
          content: null,
          isError: true,
        };
      }

      return mapPayload(payload);
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

export class MissingMcpUrlError extends Error {
  constructor() {
    super(
      "[voice] S2_VOICE_MCP_URL / config mcpUrl is required. Refusing silent mock fallback. Pass a real hub MCP URL, or use --mock-mcp only for offline tests.",
    );
    this.name = "MissingMcpUrlError";
  }
}

export interface ResolveVoiceMcpOptions {
  readonly mcpUrl: string;
  readonly mcpToken: string;
  /** Explicit offline test flag — only then may mock be used. */
  readonly useMockMcp: boolean;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Resolve the MCP bridge. Empty/missing URL fails loudly unless `--mock-mcp`.
 */
export const createVoiceMcpBridge = (options: ResolveVoiceMcpOptions): McpBridge => {
  if (options.useMockMcp) {
    return createMockMcpBridge();
  }
  const url = options.mcpUrl.trim();
  if (!url) {
    throw new MissingMcpUrlError();
  }
  return createHttpMcpBridge({
    mcpUrl: url,
    mcpToken: options.mcpToken,
    fetchImpl: options.fetchImpl,
  });
};
