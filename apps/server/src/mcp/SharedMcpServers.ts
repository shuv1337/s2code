import type {
  McpServerConfig,
  McpServerTestInput,
  McpServerTestResult,
  ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const ROUTE_PREFIX = "/mcp/servers";

/** The servers new provider sessions get, in a stable order. */
export const enabledSharedMcpServerNames = (
  settings: Pick<ServerSettings, "mcpServers">,
): ReadonlyArray<string> =>
  Object.entries(settings.mcpServers)
    .filter(([, server]) => server.enabled)
    .map(([name]) => name)
    .toSorted();

const NO_STORE = { "cache-control": "no-store, no-transform" } as const;
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-protocol-version", "mcp-session-id"];

const decodeJsonRpcRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Number]),
      method: Schema.String,
    }),
  ),
);
const decodeJsonRpcMethod = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

/** Harnesses wait on these before a session or turn can start, so a hung server must not hold them. */
const PROMPT_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);
const PROMPT_TIMEOUT = "5 seconds";

/**
 * The agent's own approval prompt is no boundary here: wherever its shell runs unasked it can call
 * this route itself. So only full-access threads, which ask for nothing, see or run these tools.
 */
const SUPERVISED_LISTINGS: Readonly<Record<string, string>> = {
  "tools/list": "tools",
  "prompts/list": "prompts",
  "resources/list": "resources",
  "resources/templates/list": "resourceTemplates",
};

const answersPromptly = (method: string, body: string) => {
  if (method === "DELETE") return true;
  if (method !== "POST") return false;
  const request = decodeJsonRpcMethod(body);
  return (
    Option.isSome(request) &&
    (PROMPT_METHODS.has(request.value.method) || request.value.method.startsWith("notifications/"))
  );
};

/**
 * A JSON-RPC error reaches the model as the call's result; an HTTP error only
 * fails the harness's transport, and a 401 can start an OAuth flow it cannot finish.
 */
const unavailable = (body: string, status: number, message: string) => {
  const request = decodeJsonRpcRequest(body);
  return Option.isSome(request)
    ? HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: request.value.id, error: { code: -32000, message } },
        { status: 200, headers: NO_STORE },
      )
    : HttpServerResponse.jsonUnsafe(
        { error: "mcp_server_unavailable", message },
        { status, headers: NO_STORE },
      );
};

/** What a supervised thread gets instead of the upstream response, or undefined to forward it. */
const supervisedAnswer = (body: string, label: string) => {
  const method = Option.getOrUndefined(decodeJsonRpcMethod(body))?.method;
  if (method !== undefined) {
    if (method === "initialize") return undefined;
    const listing = SUPERVISED_LISTINGS[method];
    const request = decodeJsonRpcRequest(body);
    if (listing !== undefined && Option.isSome(request)) {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: request.value.id, result: { [listing]: [] } },
        { headers: NO_STORE },
      );
    }
  }
  return unavailable(
    body,
    403,
    `${label} only works in threads with Full access. Switch this thread to Full access, then use Restart agent.`,
  );
};

const invalidCredential = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid T3 Code agent session credential is required.",
  },
  {
    status: 401,
    headers: { ...NO_STORE, "www-authenticate": 'Bearer error="invalid_token"' },
  },
);

const displayName = (name: string, server: McpServerConfig) => server.label ?? name;

const upstreamHeaders = (server: McpServerConfig): Record<string, string> =>
  server.bearerToken.length > 0 ? { authorization: `Bearer ${server.bearerToken}` } : {};

/** Spans would record the upstream URL; redirects are refused so the token only goes where it was saved for. */
const sendUpstream = (
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
) =>
  HttpClient.withScope(httpClient)
    .execute(request)
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.withTracerEnabled(false),
    );

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const name = url.value.pathname.slice(ROUTE_PREFIX.length + 1);
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: NO_STORE });
  }
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7).trim() : "";
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  // Only credentials T3 issued to its own agents: outside MCP clients never borrow these servers.
  const caller = yield* registry.resolve(token);
  if (caller === undefined) {
    yield* Effect.logWarning("rejected shared MCP request with an unusable credential");
    return invalidCredential;
  }
  const body = request.method === "POST" ? yield* request.text : "";
  const settings = yield* ServerSettingsService.ServerSettingsService.pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.option,
  );
  const server = Option.isSome(settings)
    ? Object.hasOwn(settings.value.mcpServers, name)
      ? settings.value.mcpServers[name as keyof ServerSettings["mcpServers"]]
      : undefined
    : undefined;
  if (server === undefined || !server.enabled) {
    return unavailable(body, 404, `MCP server "${name}" is turned off or removed in Settings.`);
  }
  // Read per request: narrowing a running thread's mode takes effect on its next call.
  const thread = yield* ProjectionStore.ProjectionStoreV2.pipe(
    Effect.flatMap((projections) => projections.getThreadShell(caller.thread.threadId)),
    Effect.orElseSucceed(() => null),
  );
  if (thread?.runtimeMode !== "full-access") {
    const answer = supervisedAnswer(body, displayName(name, server));
    if (answer !== undefined) return answer;
  }
  const headers: Record<string, string> = {};
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[header];
    if (value !== undefined) headers[header] = value;
  }
  const upstreamRequest = HttpClientRequest.make(request.method)(server.url).pipe(
    HttpClientRequest.setHeaders({ ...headers, ...upstreamHeaders(server) }),
    request.method === "POST"
      ? HttpClientRequest.setBody(
          HttpBody.text(body, request.headers["content-type"] ?? "application/json"),
        )
      : (self) => self,
  );
  const httpClient = yield* HttpClient.HttpClient;
  // Never retried: a call that may have reached the server could have changed something.
  const sent = sendUpstream(httpClient, upstreamRequest).pipe(Effect.option);
  const outcome = yield* answersPromptly(request.method, body)
    ? Effect.timeoutOption(sent, PROMPT_TIMEOUT)
    : Effect.asSome(sent);
  if (Option.isNone(outcome)) {
    return unavailable(
      body,
      504,
      `${displayName(name, server)} did not answer within ${PROMPT_TIMEOUT}.`,
    );
  }
  const response = outcome.value;
  if (Option.isNone(response)) {
    return unavailable(body, 502, `Could not reach ${displayName(name, server)}.`);
  }
  const { status } = response.value;
  if (status === 401 || status === 403) {
    yield* Effect.logWarning("shared MCP server rejected its saved credential", { name, status });
    return unavailable(
      body,
      502,
      `${displayName(name, server)} rejected the token saved for it (HTTP ${status}). Update it in Settings → MCP servers.`,
    );
  }
  if (status >= 300 && status < 400) {
    return unavailable(
      body,
      502,
      `${displayName(name, server)} redirected (HTTP ${status}); save its final URL in Settings → MCP servers.`,
    );
  }
  const responseHeaders: Record<string, string> = { ...NO_STORE };
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = response.value.headers[header];
    if (value !== undefined) responseHeaders[header] = value;
  }
  return HttpServerResponse.stream(response.value.stream, {
    status,
    headers: responseHeaders,
    ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
  });
}).pipe(Effect.withSpan("SharedMcpServers.proxy"));

export const layerProxyRoute = HttpRouter.add("*", `${ROUTE_PREFIX}/*`, proxy);

const PROTOCOL_VERSION = "2025-06-18";
const TEST_TIMEOUT = "10 seconds";

const JsonRpcResponse = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
const decodeJsonRpcResponse = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcResponse));
const decodeInitializeResult = Schema.decodeUnknownOption(
  Schema.Struct({
    serverInfo: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
  }),
);
const decodeToolsResult = Schema.decodeUnknownOption(
  Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);

/** JSON, or the server-sent events carrying it. */
const responseJson = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.map((text) =>
      response.headers["content-type"]?.includes("text/event-stream") === true
        ? (text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .findLast((line) => line.length > 0) ?? "")
        : text,
    ),
    Effect.map(decodeJsonRpcResponse),
  );

export class SharedMcpServers extends Context.Service<
  SharedMcpServers,
  {
    /** Connects as an agent would, then lists the tools agents would get. */
    readonly test: (input: McpServerTestInput) => Effect.Effect<McpServerTestResult>;
  }
>()("t3/mcp/SharedMcpServers") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;

  const test = Effect.fn("SharedMcpServers.test")(function* (input: McpServerTestInput) {
    const saved = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) =>
        Object.hasOwn(settings.mcpServers, input.id) ? settings.mcpServers[input.id] : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );
    // A saved token only goes to the URL it was saved for.
    const bearerToken =
      input.bearerToken === undefined || input.bearerToken === SECRET_REDACTED
        ? saved?.url === input.url
          ? saved.bearerToken
          : ""
        : input.bearerToken.trim();
    const post = (body: unknown, sessionId?: string) =>
      sendUpstream(
        httpClient,
        HttpClientRequest.post(input.url).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            ...(bearerToken.length > 0 ? { authorization: `Bearer ${bearerToken}` } : {}),
            ...(sessionId === undefined
              ? {}
              : { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL_VERSION }),
          }),
          HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
        ),
      );
    const handshake = Effect.gen(function* () {
      const initialized = yield* post({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3-code-settings", version: "1" },
        },
      });
      if (initialized.status !== 200) {
        return { _tag: "Rejected", status: initialized.status } as const;
      }
      const sessionId = initialized.headers["mcp-session-id"];
      const initializeResponse = yield* responseJson(initialized);
      if (Option.isNone(initializeResponse) || initializeResponse.value.error !== undefined) {
        return {
          _tag: "Failed",
          message:
            Option.getOrUndefined(initializeResponse)?.error?.message ??
            "The server did not answer like an MCP server.",
        } as const;
      }
      yield* post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
      const listed = yield* post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, sessionId);
      if (listed.status !== 200) return { _tag: "Rejected", status: listed.status } as const;
      const toolsResponse = yield* responseJson(listed);
      const tools = Option.flatMap(toolsResponse, (response) => decodeToolsResult(response.result));
      if (Option.isNone(tools)) {
        return {
          _tag: "Failed",
          message:
            Option.getOrUndefined(toolsResponse)?.error?.message ??
            "The server did not list its tools.",
        } as const;
      }
      if (sessionId !== undefined) {
        yield* sendUpstream(
          httpClient,
          HttpClientRequest.delete(input.url).pipe(
            HttpClientRequest.setHeaders({
              ...(bearerToken.length > 0 ? { authorization: `Bearer ${bearerToken}` } : {}),
              "mcp-session-id": sessionId,
            }),
          ),
        ).pipe(Effect.ignore);
      }
      const serverName = decodeInitializeResult(initializeResponse.value.result).pipe(
        Option.flatMap((result) => Option.fromNullishOr(result.serverInfo?.name)),
        Option.getOrUndefined,
      );
      return {
        _tag: "Connected",
        ...(serverName === undefined ? {} : { serverName }),
        tools: tools.value.tools.map((tool) => tool.name),
      } as const;
    });
    const result = yield* handshake.pipe(
      Effect.scoped,
      Effect.timeoutOption(TEST_TIMEOUT),
      Effect.option,
    );
    if (Option.isNone(result)) return { _tag: "Unreachable", timedOut: false } as const;
    if (Option.isNone(result.value)) return { _tag: "Unreachable", timedOut: true } as const;
    return result.value.value satisfies McpServerTestResult;
  });

  return SharedMcpServers.of({ test });
});

export const layer = Layer.effect(SharedMcpServers, make);
