// @effect-diagnostics nodeBuiltinImport:off - The fixture listens on a real port for upstream absolute URLs.
import * as NodeHttp from "node:http";

import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type McpServerConfig,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as SharedMcpServers from "./SharedMcpServers.ts";

const AGENT_TOKEN = "agent-session-token";
const UPSTREAM_TOKEN = "upstream-secret";
const invocation = {
  environmentId: EnvironmentId.make("environment-shared-mcp-test"),
  requestNamespace: "provider-session-shared-mcp-test",
  thread: {
    threadId: ThreadId.make("thread-shared-mcp-test"),
    providerSessionId: "provider-session-shared-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const TOOLS_SSE = `event: message\ndata: ${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      {
        name: "search",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      { name: "execute", inputSchema: { type: "object" } },
    ],
  },
})}\n\n`;
const FAILED_CALL = {
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text: "quota exceeded" }], isError: true },
};

interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers like a small streamable-HTTP MCP server that requires `UPSTREAM_TOKEN`. */
const upstream = (received: Array<Received>, hung: Queue.Queue<string>) =>
  HttpRouter.add(
    "*",
    "/upstream/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://fixture").pathname;
      const body = request.method === "POST" ? yield* request.text : "";
      received.push({ method: request.method, path, headers: request.headers, body });
      if (path === "/upstream/hang")
        return yield* Queue.offer(hung, body).pipe(Effect.andThen(Effect.never));
      if (path === "/upstream/moved") {
        return HttpServerResponse.empty({ status: 302, headers: { location: "/upstream/mcp" } });
      }
      if (path === "/upstream/html") return HttpServerResponse.html("<html>hello</html>");
      if (path === "/upstream/broken") {
        return HttpServerResponse.text(
          '{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"boom"}}',
          {
            status: 500,
            contentType: "application/json",
          },
        );
      }
      if (request.headers.authorization !== `Bearer ${UPSTREAM_TOKEN}`) {
        return HttpServerResponse.text("unauthorized", { status: 401 });
      }
      if (request.method === "GET" || request.method === "DELETE")
        return HttpServerResponse.empty({ status: 200 });
      const message = JSON.parse(body) as { id?: number; method: string };
      switch (message.method) {
        case "initialize":
          return HttpServerResponse.jsonUnsafe(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "Fixture" },
              },
            },
            { headers: { "mcp-session-id": "session-1" } },
          );
        case "notifications/initialized":
          return HttpServerResponse.empty({ status: 202 });
        case "tools/list":
          return HttpServerResponse.text(TOOLS_SSE, { contentType: "text/event-stream" });
        default:
          return HttpServerResponse.jsonUnsafe(FAILED_CALL);
      }
    }),
  );

const server = (url: string, overrides: Partial<McpServerConfig> = {}) => ({
  url,
  bearerToken: UPSTREAM_TOKEN,
  enabled: true,
  ...overrides,
});

const fixture = Effect.gen(function* () {
  const received: Array<Received> = [];
  let bearerTokenReads = 0;
  const hung = yield* Queue.unbounded<string>();
  const settings = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  const settingsLayer = Layer.mock(ServerSettingsService.ServerSettingsService)({
    getSettings: Ref.get(settings),
  });
  /** The calling thread's current mode, or null for a thread that can't be read. */
  const runtimeMode = yield* Ref.make<RuntimeMode | null>("full-access");
  const threadPlacement = yield* Ref.make<
    Partial<Pick<OrchestrationV2ThreadShell, "projectId" | "lineage" | "delegatedFrom">>
  >({});
  const projectionsLayer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadShell: (threadId) =>
      Effect.all([Ref.get(runtimeMode), Ref.get(threadPlacement)]).pipe(
        Effect.map(([mode, placement]) =>
          mode === null
            ? null
            : { ...liveThreadShell(threadId, { runtimeMode: mode }), ...placement },
        ),
      ),
  });
  const services = yield* Layer.build(
    Layer.mergeAll(
      HttpRouter.serve(
        Layer.mergeAll(
          SharedMcpServers.layerProxyRoute,
          upstream(received, hung),
          HttpRouter.add("*", "/mcp", HttpServerResponse.text("orchestration")),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" }),
        ),
      ),
      SharedMcpServers.layer,
    ).pipe(
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (token) => Effect.succeed(token === AGENT_TOKEN ? invocation : undefined),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provide(projectionsLayer),
      Layer.provideMerge(FetchHttpClient.layer),
    ),
  );
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  yield* Ref.update(settings, (current) => ({
    ...current,
    mcpServers: {
      executor: {
        ...server(`${origin}/upstream/mcp`, { label: "Executor" }),
        get bearerToken() {
          bearerTokenReads += 1;
          return UPSTREAM_TOKEN;
        },
      },
      denied: server(`${origin}/upstream/mcp`, { bearerToken: "stale" }),
      broken: server(`${origin}/upstream/broken`),
      moved: server(`${origin}/upstream/moved`),
      offline: server("http://127.0.0.1:1/mcp", { label: "Offline" }),
      paused: server(`${origin}/upstream/mcp`, { enabled: false }),
      hang: server(`${origin}/upstream/hang`, { label: "Hang" }),
      bound: server(`${origin}/upstream/mcp`, {
        label: "Bound",
        projectIds: [ProjectId.make("project:mcp-test")],
        excludeSubagents: true,
      }),
    } as ServerSettings["mcpServers"],
  }));
  const httpClient = Context.get(services, HttpClient.HttpClient);
  const call = (
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; method?: "POST" | "GET" | "DELETE" },
  ) =>
    httpClient.execute(
      HttpClientRequest.make(init.method ?? "POST")(`${origin}${path}`).pipe(
        HttpClientRequest.setHeaders(init.headers ?? {}),
        init.body === undefined
          ? (request) => request
          : HttpClientRequest.setBody(HttpBody.text(JSON.stringify(init.body), "application/json")),
      ),
    );
  return {
    origin,
    received,
    bearerTokenReads: () => bearerTokenReads,
    hung,
    runtimeMode,
    threadPlacement,
    call,
    shared: Context.get(services, SharedMcpServers.SharedMcpServers),
  };
});

const asAgent = { authorization: `Bearer ${AGENT_TOKEN}` };

it.effect(
  "forwards agent requests with the saved token and passes responses through untouched",
  () =>
    Effect.gen(function* () {
      const { call, received } = yield* fixture;
      const initialize = yield* call("/mcp/servers/executor", {
        body: { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
        headers: {
          ...asAgent,
          accept: "application/json, text/event-stream",
          cookie: "t3_session=browser-secret",
          "x-forwarded-for": "203.0.113.9",
          "mcp-protocol-version": "2025-06-18",
        },
      });
      expect(initialize.status).toBe(200);
      expect(initialize.headers["mcp-session-id"]).toBe("session-1");
      expect(initialize.headers["cache-control"]).toBe("no-store, no-transform");
      expect(yield* initialize.json).toMatchObject({
        id: 0,
        result: { serverInfo: { name: "Fixture" } },
      });

      const session = { ...asAgent, "mcp-session-id": "session-1" };
      const listed = yield* call("/mcp/servers/executor", {
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        headers: session,
      });
      expect(listed.headers["content-type"]).toContain("text/event-stream");
      expect(yield* listed.text).toBe(TOOLS_SSE);

      const failedCall = yield* call("/mcp/servers/executor", {
        body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute" } },
        headers: session,
      });
      expect(yield* failedCall.json).toEqual(FAILED_CALL);
      expect(
        (yield* call("/mcp/servers/executor", { method: "DELETE", headers: session })).status,
      ).toBe(200);

      expect(received.map((request) => [request.method, request.headers.authorization])).toEqual([
        ["POST", `Bearer ${UPSTREAM_TOKEN}`],
        ["POST", `Bearer ${UPSTREAM_TOKEN}`],
        ["POST", `Bearer ${UPSTREAM_TOKEN}`],
        ["DELETE", `Bearer ${UPSTREAM_TOKEN}`],
      ]);
      expect(received[0]?.headers).toMatchObject({
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      });
      expect(received[0]?.headers).not.toHaveProperty("cookie");
      expect(received[0]?.headers).not.toHaveProperty("x-forwarded-for");
      expect(received[1]?.headers["mcp-session-id"]).toBe("session-1");
    }),
);

it.effect("only serves credentials T3 issued to its agents", () =>
  Effect.gen(function* () {
    const { call, received } = yield* fixture;
    const body = { jsonrpc: "2.0", id: 0, method: "initialize", params: {} };
    for (const headers of [{}, { authorization: "Bearer someone-elses-oauth-token" }]) {
      const response = yield* call("/mcp/servers/executor", { body, headers });
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
    }
    expect(received).toEqual([]);
    expect(yield* (yield* call("/mcp", { method: "GET" })).text).toBe("orchestration");
  }),
);

it.effect.each(
  (["approval-required", "auto-accept-edits", "auto", "full-access", null] as const).flatMap(
    (mode) =>
      (
        [
          { method: "GET", rpcMethod: undefined },
          { method: "DELETE", rpcMethod: undefined },
          { method: "POST", rpcMethod: "tools/call" },
          { method: "POST", rpcMethod: "ping" },
          { method: "POST", rpcMethod: "notifications/initialized" },
        ] as const
      ).map((request) => ({ mode, ...request })),
  ),
)("gates $method $rpcMethod in $mode before using the saved token", ({ mode, method, rpcMethod }) =>
  Effect.gen(function* () {
    const { call, received, runtimeMode, bearerTokenReads } = yield* fixture;
    yield* Ref.set(runtimeMode, mode);
    const response = yield* call("/mcp/servers/executor", {
      method,
      headers: asAgent,
      ...(rpcMethod === undefined
        ? {}
        : {
            body: {
              jsonrpc: "2.0",
              ...(rpcMethod.startsWith("notifications/") ? {} : { id: 2 }),
              method: rpcMethod,
            },
          }),
    });
    if (mode === "full-access") {
      expect(response.status).toBe(rpcMethod === "notifications/initialized" ? 202 : 200);
      expect(received).toHaveLength(1);
      expect(received[0]?.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
      expect(bearerTokenReads()).toBeGreaterThan(0);
    } else {
      expect(received).toEqual([]);
      expect(bearerTokenReads()).toBe(0);
      expect(response.status).toBe(
        method === "POST" && rpcMethod !== "notifications/initialized" ? 200 : 403,
      );
      expect(yield* response.text).toContain("only works in threads with Full access");
    }
  }),
);

it.effect("offers and runs shared tools only for threads in full access", () =>
  Effect.gen(function* () {
    const { call, received, runtimeMode } = yield* fixture;
    const send = (body: unknown) =>
      call("/mcp/servers/executor", { body, headers: asAgent }).pipe(
        Effect.flatMap((response) => response.json),
      );
    const execute = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute" } };
    const refused = {
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32000,
        message:
          "Executor only works in threads with Full access. Switch this thread to Full access, then use Restart agent.",
      },
    };

    for (const mode of ["approval-required", "auto-accept-edits", "auto", null] as const) {
      yield* Ref.set(runtimeMode, mode);
      expect(
        yield* send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
      ).toMatchObject({
        result: { serverInfo: { name: "Fixture" } },
      });
      const requestsBeforeListing = received.length;
      for (const [method, field] of Object.entries({
        "tools/list": "tools",
        "prompts/list": "prompts",
        "resources/list": "resources",
        "resources/templates/list": "resourceTemplates",
      })) {
        expect(yield* send({ jsonrpc: "2.0", id: 1, method })).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { [field]: [] },
        });
      }
      expect(received).toHaveLength(requestsBeforeListing);
      expect(yield* send(execute)).toEqual(refused);
      expect(yield* send({ ...execute, method: "resources/read" })).toEqual(refused);
      const batch = yield* call("/mcp/servers/executor", { body: [execute], headers: asAgent });
      expect(batch.status).toBe(403);
    }

    yield* Ref.set(runtimeMode, null);
    expect(yield* send(execute)).toEqual(refused);
    expect(received.map((request) => JSON.parse(request.body).method)).toEqual(
      Array(4).fill("initialize"),
    );

    yield* Ref.set(runtimeMode, "full-access");
    expect(yield* send(execute)).toEqual(FAILED_CALL);
  }),
);

it.effect("serves a bound server only to top-level threads of its projects, never upstream", () =>
  Effect.gen(function* () {
    const { call, received, runtimeMode, threadPlacement } = yield* fixture;
    const send = (method: string) =>
      call("/mcp/servers/bound", {
        body: { jsonrpc: "2.0", id: 1, method, params: {} },
        headers: asAgent,
      }).pipe(Effect.flatMap((response) => response.json));
    const refused = {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32000,
        message:
          "Bound is not available in this thread. Settings → MCP servers limits it to certain projects or to top-level threads.",
      },
    };

    expect(yield* send("tools/call")).toEqual(FAILED_CALL);
    expect(received).toHaveLength(1);

    const threadId = invocation.thread.threadId;
    for (const placement of [
      { projectId: ProjectId.make("project:elsewhere") },
      {
        lineage: {
          rootThreadId: threadId,
          parentThreadId: threadId,
          relationshipToParent: "subagent" as const,
        },
      },
      {
        delegatedFrom: {
          environmentId: EnvironmentId.make("environment:elsewhere"),
          threadId,
          title: "Elsewhere",
        },
      },
      undefined,
    ]) {
      if (placement === undefined) yield* Ref.set(runtimeMode, null);
      else yield* Ref.set(threadPlacement, placement);
      expect(yield* send("initialize")).toEqual(refused);
      expect(yield* send("tools/call")).toEqual(refused);
      expect(yield* send("tools/list")).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
      yield* Ref.set(threadPlacement, {});
    }
    expect(received).toHaveLength(1);
  }),
);

it.effect("answers JSON-RPC errors for servers agents cannot use, without retrying", () =>
  Effect.gen(function* () {
    const { call, received } = yield* fixture;
    const request = (name: string) =>
      call(`/mcp/servers/${name}`, {
        body: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "execute" } },
        headers: asAgent,
      });
    const errorMessage = (name: string) =>
      request(name).pipe(
        Effect.flatMap((response) => {
          expect(response.status).toBe(200);
          return response.json;
        }),
        Effect.map((body) => {
          expect(body).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32000 } });
          return (body as { error: { message: string } }).error.message;
        }),
      );

    expect(yield* errorMessage("denied")).toContain("rejected the token saved for it (HTTP 401)");
    expect(yield* errorMessage("moved")).toContain("redirected (HTTP 302)");
    expect(yield* errorMessage("offline")).toBe("Could not reach Offline.");
    expect(yield* errorMessage("paused")).toContain("turned off or removed");
    expect(yield* errorMessage("missing")).toContain("turned off or removed");

    const broken = yield* request("broken");
    expect(broken.status).toBe(500);
    expect(yield* broken.json).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32603, message: "boom" },
    });
    expect(received.map((entry) => entry.path)).toEqual([
      "/upstream/mcp",
      "/upstream/moved",
      "/upstream/broken",
    ]);

    const notification = yield* call("/mcp/servers/paused", {
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      headers: asAgent,
    });
    expect(notification.status).toBe(404);
  }),
);

it.effect("tests a server the way agents connect to it", () =>
  Effect.gen(function* () {
    const { origin, received, shared } = yield* fixture;
    const url = `${origin}/upstream/mcp`;
    expect(
      yield* shared.test({ id: McpServerId.make("executor"), url, bearerToken: SECRET_REDACTED }),
    ).toEqual({
      _tag: "Connected",
      serverName: "Fixture",
      tools: ["search", "execute"],
    });
    expect(received.map((entry) => [entry.method, entry.headers.authorization])).toEqual([
      ["POST", `Bearer ${UPSTREAM_TOKEN}`],
      ["POST", `Bearer ${UPSTREAM_TOKEN}`],
      ["POST", `Bearer ${UPSTREAM_TOKEN}`],
      ["DELETE", `Bearer ${UPSTREAM_TOKEN}`],
    ]);

    received.length = 0;
    // The saved token stays with the URL it was saved for.
    expect(
      yield* shared.test({
        id: McpServerId.make("executor"),
        url: `${url}?moved`,
        bearerToken: SECRET_REDACTED,
      }),
    ).toEqual({ _tag: "Rejected", status: 401 });
    expect(received[0]?.headers).not.toHaveProperty("authorization");
    expect(
      yield* shared.test({ id: McpServerId.make("executor"), url, bearerToken: "typo" }),
    ).toEqual({
      _tag: "Rejected",
      status: 401,
    });
    expect(
      yield* shared.test({ id: McpServerId.make("html"), url: `${origin}/upstream/html` }),
    ).toEqual({
      _tag: "Failed",
      message: "The server did not answer like an MCP server.",
    });
    expect(
      yield* shared.test({ id: McpServerId.make("offline"), url: "http://127.0.0.1:1/mcp" }),
    ).toEqual({
      _tag: "Unreachable",
      timedOut: false,
    });
  }),
);

it.effect("reports a server that never answers as timed out", () =>
  Effect.gen(function* () {
    const { origin, hung, shared } = yield* fixture;
    const testing = yield* shared
      .test({ id: McpServerId.make("hang"), url: `${origin}/upstream/hang` })
      .pipe(Effect.forkChild);
    yield* Queue.take(hung);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(testing)).toEqual({ _tag: "Unreachable", timedOut: true });
  }),
);

it.effect("gives a hung server a deadline only where harnesses wait to start", () =>
  Effect.gen(function* () {
    const { call, hung } = yield* fixture;
    const send = (body: unknown) =>
      call("/mcp/servers/hang", { body, headers: asAgent }).pipe(Effect.forkChild);

    const listing = yield* send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(yield* Queue.take(hung)).toContain("tools/list");
    yield* TestClock.adjust("5 seconds");
    expect(yield* (yield* Fiber.join(listing)).json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Hang did not answer within 5 seconds." },
    });

    const toolCall = yield* send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    expect(yield* Queue.take(hung)).toContain("tools/call");
    yield* TestClock.adjust("10 minutes");
    expect(toolCall.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(toolCall);
  }),
);
