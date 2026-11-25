import {
  isDelegatedAppThread,
  isEnabledMcpServer,
  isHttpMcpServer,
  isStdioMcpServer,
  type McpServerConfig,
  type McpServerStdioConfig,
  type McpServerTestInput,
  type McpServerTestResult,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
import * as StdioMcpBridge from "./StdioMcpBridge.ts";

const ROUTE_PREFIX = "/mcp/servers";

export interface SharedMcpServerAudience {
  readonly projectId: ProjectId;
  readonly subagent: boolean;
}

/** Cross-project and linked-environment delegates have no subagent lineage, only `delegatedFrom`. */
export const sharedMcpServerAudience = (
  thread: Pick<OrchestrationV2ThreadShell, "projectId" | "lineage" | "delegatedFrom">,
  subagentCredential = false,
): SharedMcpServerAudience => ({
  projectId: thread.projectId,
  subagent: subagentCredential || isDelegatedAppThread(thread),
});

export const sharedMcpServerAdmits = (
  server: Pick<McpServerConfig, "projectIds" | "excludeSubagents">,
  thread: SharedMcpServerAudience,
): boolean => {
  const projectIds = server.projectIds ?? [];
  if (projectIds.length > 0 && !projectIds.includes(thread.projectId)) return false;
  return server.excludeSubagents !== true || !thread.subagent;
};

/** The servers a thread's new provider sessions get, in a stable order; a thread that can't be read gets none. */
export const enabledSharedMcpServerNames = (
  settings: Pick<ServerSettings, "mcpServers">,
  thread: SharedMcpServerAudience | undefined,
): ReadonlyArray<string> =>
  thread === undefined
    ? []
    : Object.entries(settings.mcpServers)
        .filter(([, server]) => isEnabledMcpServer(server) && sharedMcpServerAdmits(server, thread))
        .map(([name]) => name)
        .toSorted();

const NO_STORE = { "cache-control": "no-store, no-transform" } as const;
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-method",
  "mcp-name",
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
const isModernRequest = (body: string) => {
  if (body.length === 0) return false;
  try {
    const request: unknown = JSON.parse(body);
    return (
      Predicate.isReadonlyObject(request) &&
      Predicate.isReadonlyObject(request.params) &&
      Predicate.isReadonlyObject(request.params._meta) &&
      Object.hasOwn(request.params._meta, "io.modelcontextprotocol/protocolVersion")
    );
  } catch {
    return false;
  }
};

// T3 only synthesizes initialize-era answers. Empty HTTP 400 tells modern clients to fall back.
const modernFallback = HttpServerResponse.empty({ status: 400, headers: NO_STORE });

/** Harnesses wait on these before a session or turn can start, so a hung server must not hold them. */
const PROMPT_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "server/discover",
  "skills/list",
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
  "skills/list": "skills",
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

const emptyListing = (body: string) => {
  const method = Option.getOrUndefined(decodeJsonRpcMethod(body))?.method;
  const listing = method === undefined ? undefined : SUPERVISED_LISTINGS[method];
  const request = decodeJsonRpcRequest(body);
  return listing !== undefined && Option.isSome(request)
    ? HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: request.value.id, result: { [listing]: [] } },
        { headers: NO_STORE },
      )
    : undefined;
};

const fullAccessOnly = (body: string, label: string) =>
  unavailable(
    body,
    403,
    `${label} only works in threads with Full access. Switch this thread to Full access, then use Restart agent.`,
  );

/** What a supervised thread gets instead of the upstream response, or undefined to forward it. */
const supervisedAnswer = (body: string, label: string) => {
  if (Option.getOrUndefined(decodeJsonRpcMethod(body))?.method === "initialize") return undefined;
  return emptyListing(body) ?? fullAccessOnly(body, label);
};

/** No bridge session has this id, so after a switch to Full access the next call gets 404 and re-initializes. */
const SUPERVISED_STDIO_SESSION = "supervised";

const decodeInitializeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Number]),
      method: Schema.Literal("initialize"),
      params: Schema.optional(Schema.Struct({ protocolVersion: Schema.optional(Schema.String) })),
    }),
  ),
);

/**
 * A supervised thread can't use a stdio server's tools, so it never starts its process: T3 answers
 * the handshake itself, with no session, and the rest as it does for an HTTP server.
 */
const supervisedStdioAnswer = (method: string, body: string, label: string) => {
  // Closing a session from before the switch only stops its process.
  if (method === "DELETE") return undefined;
  if (method !== "POST") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: NO_STORE });
  }
  const initialize = decodeInitializeRequest(body);
  if (Option.isSome(initialize)) {
    return HttpServerResponse.jsonUnsafe(
      {
        jsonrpc: "2.0",
        id: initialize.value.id,
        result: {
          protocolVersion: initialize.value.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: label, version: "0" },
        },
      },
      {
        headers: {
          ...NO_STORE,
          "mcp-session-id": SUPERVISED_STDIO_SESSION,
        },
      },
    );
  }
  if (Option.getOrUndefined(decodeJsonRpcMethod(body))?.method.startsWith("notifications/")) {
    return HttpServerResponse.empty({ status: 202, headers: NO_STORE });
  }
  return supervisedAnswer(body, label) ?? fullAccessOnly(body, label);
};

/** A thread outside a server's binding never reaches it, not even to initialize. */
const unboundAnswer = (body: string, label: string) =>
  emptyListing(body) ??
  unavailable(
    body,
    403,
    `${label} is not available in this thread. Settings → MCP servers limits it to certain projects or to top-level threads.`,
  );

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

const displayName = (name: string, server: McpServerConfig | McpServerStdioConfig) =>
  server.label ?? name;

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
  if (server === undefined || !isEnabledMcpServer(server)) {
    return unavailable(body, 404, `MCP server "${name}" is turned off or removed in Settings.`);
  }
  // Read per request: narrowing a running thread's mode or a server's binding takes effect on its next call.
  const thread = yield* ProjectionStore.ProjectionStoreV2.pipe(
    Effect.flatMap((projections) => projections.getThreadShell(caller.thread.threadId)),
    Effect.orElseSucceed(() => null),
  );
  if (thread === null) {
    if (isModernRequest(body)) return modernFallback;
    return (
      emptyListing(body) ??
      unavailable(
        body,
        503,
        `${displayName(name, server)} is unavailable because T3 Code could not read this thread.`,
      )
    );
  }
  if (
    !sharedMcpServerAdmits(server, sharedMcpServerAudience(thread, caller.thread.subagent === true))
  ) {
    if (isModernRequest(body)) return modernFallback;
    return unboundAnswer(body, displayName(name, server));
  }
  if (thread.runtimeMode !== "full-access") {
    if (isModernRequest(body)) return modernFallback;
    const answer = isStdioMcpServer(server)
      ? supervisedStdioAnswer(request.method, body, displayName(name, server))
      : supervisedAnswer(body, displayName(name, server));
    if (answer !== undefined) return answer;
  }
  if (isStdioMcpServer(server)) {
    const bridge = yield* StdioMcpBridge.StdioMcpBridge;
    const answer = bridge.handle({
      serverId: name,
      server,
      owner: caller.thread.threadId,
      method: request.method,
      sessionId: request.headers["mcp-session-id"],
      body,
    });
    // initialize spawns the process and has the bridge's own longer limit.
    const prompt =
      answersPromptly(request.method, body) &&
      Option.getOrUndefined(decodeJsonRpcMethod(body))?.method !== "initialize";
    const bridged = yield* prompt
      ? Effect.timeoutOption(answer, PROMPT_TIMEOUT)
      : Effect.asSome(answer);
    if (Option.isNone(bridged)) {
      return unavailable(
        body,
        504,
        `${displayName(name, server)} did not answer within ${PROMPT_TIMEOUT}.`,
      );
    }
    return HttpServerResponse.text(bridged.value.body, {
      status: bridged.value.status,
      headers: { ...NO_STORE, ...bridged.value.headers },
      ...(bridged.value.headers["content-type"] === undefined
        ? {}
        : { contentType: bridged.value.headers["content-type"] }),
    });
  }
  const headers: Record<string, string> = {};
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[header];
    if (value !== undefined) headers[header] = value;
  }
  for (const [header, value] of Object.entries(request.headers)) {
    if (/^mcp-param-[a-z0-9-]+$/i.test(header)) headers[header] = value;
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

const RETIRE_WATCHER_RESTART_DELAY = "1 second";

/** Stops a removed, disabled or edited stdio entry's processes now, not at their next call or idle. */
const layerRetireStaleStdioSessions = Layer.effectDiscard(
  Effect.gen(function* () {
    const bridge = yield* StdioMcpBridge.StdioMcpBridge;
    const settings = yield* ServerSettingsService.ServerSettingsService;
    const reconcileSnapshot = settings.getSettings.pipe(
      Effect.option,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (current) => bridge.reconcile(current.mcpServers),
        }),
      ),
    );
    const watch = Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reconciling the snapshot so changes during startup or restart are not missed.
        const fiber = yield* settings.streamChanges.pipe(
          Stream.runForEach((next) => bridge.reconcile(next.mcpServers)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* reconcileSnapshot;
        return yield* Fiber.join(fiber);
      }),
    );
    yield* watch.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.interrupt
          : Effect.logWarning("shared MCP stdio settings watcher stopped; restarting", {
              cause: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "settings stream ended",
            }),
      ),
      Effect.andThen(Effect.sleep(RETIRE_WATCHER_RESTART_DELAY)),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);

export const layerProxyRoute = Layer.merge(
  Layer.unwrap(
    Effect.gen(function* () {
      const bridge = yield* StdioMcpBridge.StdioMcpBridge;
      return HttpRouter.add(
        "*",
        `${ROUTE_PREFIX}/*`,
        proxy.pipe(Effect.provideService(StdioMcpBridge.StdioMcpBridge, bridge)),
      );
    }),
  ),
  layerRetireStaleStdioSessions,
).pipe(Layer.provide(StdioMcpBridge.layer));

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
    /** Tests a settings draft, resolving a saved token only when requested. */
    readonly test: (input: McpServerTestInput) => Effect.Effect<McpServerTestResult>;
    readonly testConnection: (
      server: Pick<McpServerConfig, "url" | "bearerToken">,
    ) => Effect.Effect<McpServerTestResult>;
    readonly testStdioConnection: (
      server: Pick<McpServerStdioConfig, "command" | "args" | "env">,
    ) => Effect.Effect<McpServerTestResult>;
  }
>()("t3/mcp/SharedMcpServers") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;

  const testConnection = Effect.fn("SharedMcpServers.testConnection")(function* ({
    url,
    bearerToken,
  }: Pick<McpServerConfig, "url" | "bearerToken">) {
    const post = (body: unknown, sessionId?: string) =>
      sendUpstream(
        httpClient,
        HttpClientRequest.post(url).pipe(
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
          HttpClientRequest.delete(url).pipe(
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

  const test = Effect.fn("SharedMcpServers.test")(function* (input: McpServerTestInput) {
    if (input.bearerToken !== undefined && input.bearerToken !== SECRET_REDACTED) {
      return yield* testConnection({ url: input.url, bearerToken: input.bearerToken.trim() });
    }
    const saved = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) =>
        Object.hasOwn(settings.mcpServers, input.id) ? settings.mcpServers[input.id] : undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );
    // A saved token only goes to the URL it was saved for.
    return yield* testConnection({
      url: input.url,
      bearerToken:
        saved !== undefined && isHttpMcpServer(saved) && saved.url === input.url
          ? saved.bearerToken
          : "",
    });
  });

  const testStdioConnection = (server: Pick<McpServerStdioConfig, "command" | "args" | "env">) =>
    Effect.promise(() => StdioMcpBridge.testStdioServer(server)).pipe(
      Effect.map((result): McpServerTestResult => result),
      Effect.withSpan("SharedMcpServers.testStdioConnection"),
    );

  return SharedMcpServers.of({ test, testConnection, testStdioConnection });
});

export const layer = Layer.effect(SharedMcpServers, make);
