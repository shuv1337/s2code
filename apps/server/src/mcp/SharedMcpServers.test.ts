// @effect-diagnostics nodeBuiltinImport:off - The fixture listens on a real port for upstream absolute URLs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpProtocol, McpServer } from "effect/ai";
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
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as SharedMcpServerManagement from "./SharedMcpServerManagement.ts";
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

const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const PROTOCOL_CLAIM = "io.modelcontextprotocol/protocolVersion";
const MODERN_VERSION = "2026-07-28";
const MCP_ACCEPT = "application/json, text/event-stream";
const SKILL_URI = "skill://fixture/example/SKILL.md";
const SKILL_DIR = "skill://fixture/example/";
const SKILL_FRONTMATTER = { name: "example", description: "An example skill" };
const SKILL_TEXT = "---\nname: example\ndescription: An example skill\n---\n\nUse café.\r\n";
const skillDigest = (text: string) =>
  `sha256:${NodeCrypto.createHash("sha256").update(text).digest("hex")}`;
const SKILL_CAPABILITIES = {
  resources: { listChanged: true },
  extensions: { [SKILLS_EXTENSION]: { directoryRead: true } },
};
const SKILL_ENTRY = {
  uri: SKILL_URI,
  frontmatter: SKILL_FRONTMATTER,
  resources: [
    { uri: SKILL_URI, digest: skillDigest(SKILL_TEXT), size: Buffer.byteLength(SKILL_TEXT) },
  ],
};
const SKILL_CONTENTS = [{ uri: SKILL_URI, mimeType: "text/markdown", text: SKILL_TEXT }];
const SKILL_DIRECTORY = [{ uri: SKILL_URI, name: "SKILL.md", mimeType: "text/markdown" }];
const SKILL_READ_METHODS = ["skills/get", "resources/read", "resources/directory/read"] as const;
const SKILL_CHANGED = 'data: {"jsonrpc":"2.0","method":"notifications/resources/list_changed"}\n\n';
const rpc = (method: string, params?: Record<string, unknown>, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});
const modernRpc = (method: string, params?: Record<string, unknown>, version = MODERN_VERSION) =>
  rpc(method, {
    ...params,
    _meta: {
      [PROTOCOL_CLAIM]: version,
      "io.modelcontextprotocol/clientCapabilities": { extensions: { [SKILLS_EXTENSION]: {} } },
      "io.modelcontextprotocol/clientInfo": { name: "fixture-client", version: "1" },
    },
  });
const modernHeaders = (method: string, name?: string, version = MODERN_VERSION) => ({
  accept: MCP_ACCEPT,
  "mcp-protocol-version": version,
  "mcp-method": method,
  ...(name === undefined ? {} : { "mcp-name": name }),
});

const realSkillsUpstream = McpServer.layerHttp({
  name: "Effect skills",
  version: "1",
  path: "/effect-skills",
  protocols: [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28],
  registrations: McpServer.skill({ uri: SKILL_URI, files: { "SKILL.md": SKILL_TEXT } }),
});

interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Answers like a small streamable-HTTP MCP server that requires `UPSTREAM_TOKEN`. */
const upstream = (
  received: Array<Received>,
  hung: Queue.Queue<string>,
  upstreamStreamClosed: Deferred.Deferred<void>,
  releaseStalledBody: Deferred.Deferred<void>,
) =>
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
      if (path === "/upstream/stall-body") {
        return HttpServerResponse.stream(
          Stream.succeed("{").pipe(
            Stream.concat(Stream.fromEffect(Queue.offer(hung, body)).pipe(Stream.drain)),
            Stream.concat(Stream.fromEffect(Deferred.await(releaseStalledBody)).pipe(Stream.drain)),
            Stream.encodeText,
            Stream.ensuring(Deferred.succeed(upstreamStreamClosed, undefined)),
          ),
          { contentType: "application/json" },
        );
      }
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
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { uri?: string; _meta?: Record<string, unknown> };
      };
      if (path === "/upstream/skills") {
        const version = message.params?._meta?.[PROTOCOL_CLAIM];
        const modern = version !== undefined;
        const error = (code: number, messageText: string) =>
          HttpServerResponse.jsonUnsafe(
            { jsonrpc: "2.0", id: message.id, error: { code, message: messageText } },
            { status: 400 },
          );
        if (modern) {
          if (
            request.headers["mcp-protocol-version"] !== version ||
            request.headers["mcp-method"] !== message.method ||
            (message.method === "resources/read" &&
              request.headers["mcp-name"] !== message.params?.uri)
          ) {
            return error(-32020, "Routing headers do not match the request");
          }
          if (version !== MODERN_VERSION) return error(-32022, "Unsupported protocol version");
        }
        const reply = (result: Record<string, unknown>) =>
          HttpServerResponse.jsonUnsafe(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: modern
                ? { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result }
                : result,
            },
            modern ? { headers: { "mcp-protocol-version": MODERN_VERSION } } : undefined,
          );
        switch (message.method) {
          case "server/discover":
            return reply({ supportedVersions: [MODERN_VERSION], capabilities: SKILL_CAPABILITIES });
          case "skills/list":
            return reply({ skills: [SKILL_ENTRY] });
          case "skills/get":
            return reply({ skill: SKILL_ENTRY });
          case "resources/read":
            return reply({ contents: SKILL_CONTENTS });
          case "resources/directory/read":
            return reply({ resources: SKILL_DIRECTORY });
          case "subscriptions/listen":
            return HttpServerResponse.stream(
              Stream.concat(Stream.succeed(SKILL_CHANGED), Stream.never).pipe(
                Stream.encodeText,
                Stream.ensuring(Deferred.succeed(upstreamStreamClosed, undefined)),
              ),
              { contentType: "text/event-stream" },
            );
        }
      }
      switch (message.method) {
        case "server/discover":
          return HttpServerResponse.empty({ status: 400 });
        case "initialize":
          return HttpServerResponse.jsonUnsafe(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: path === "/upstream/skills" ? SKILL_CAPABILITIES : {},
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

/** `brokenSettingsStream`: the first subscription to settings changes dies, as a crashed watcher would. */
const makeFixture = (
  options: { readonly brokenSettingsStream?: boolean; readonly realSkills?: boolean } = {},
) =>
  Effect.gen(function* () {
    const spawnMarker = NodePath.join(
      NodeOS.tmpdir(),
      `s2code-stdio-tripwire-${NodeCrypto.randomUUID()}`,
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(spawnMarker, { force: true })),
    );
    const received: Array<Received> = [];
    let bearerTokenReads = 0;
    const hung = yield* Queue.unbounded<string>();
    const upstreamStreamClosed = yield* Deferred.make<void>();
    const releaseStalledBody = yield* Deferred.make<void>();
    const settings = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    let streamSubscriptions = 0;
    const settingsLayer = Layer.mock(ServerSettingsService.ServerSettingsService)({
      getSettings: Ref.get(settings),
      streamChanges: Stream.unwrap(
        Effect.sync(() => streamSubscriptions++).pipe(
          Effect.map((count) =>
            options.brokenSettingsStream === true && count === 0
              ? Stream.die(new Error("settings stream broke"))
              : Stream.fromPubSub(settingsChanges),
          ),
        ),
      ),
    });
    /** Saves settings the way the real service does: the new value, then a change event. */
    const saveMcpServers = (
      update: (current: ServerSettings["mcpServers"]) => ServerSettings["mcpServers"],
    ) =>
      Ref.updateAndGet(settings, (current) => ({
        ...current,
        mcpServers: update(current.mcpServers),
      })).pipe(Effect.flatMap((next) => PubSub.publish(settingsChanges, next)));
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
            upstream(received, hung, upstreamStreamClosed, releaseStalledBody),
            options.realSkills === true ? realSkillsUpstream : Layer.empty,
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
        "stall-body": server(`${origin}/upstream/stall-body`, { label: "Stalled discovery" }),
        skills: server(`${origin}/upstream/skills`, { label: "Skills" }),
        "effect-skills": server(`${origin}/effect-skills`),
        local: {
          transport: "stdio",
          label: "Local",
          command: process.execPath,
          args: [
            NodeURL.fileURLToPath(new URL("./testdata/fakeStdioMcpServer.mjs", import.meta.url)),
          ],
          env: { FAKE_MCP_SKILLS: "1", FAKE_MCP_SPAWN_MARKER: spawnMarker },
          enabled: true,
        },
        // Leaves a file behind if T3 ever starts it.
        tripwire: {
          transport: "stdio",
          label: "Tripwire",
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(spawnMarker)}, "")`],
          env: {},
          enabled: true,
        },
        future: { transport: "websocket", endpoint: "wss://example.invalid", enabled: true },
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
      init: {
        body?: unknown;
        headers?: Record<string, string>;
        method?: "POST" | "GET" | "DELETE";
      },
    ) =>
      httpClient.execute(
        HttpClientRequest.make(init.method ?? "POST")(`${origin}${path}`).pipe(
          HttpClientRequest.setHeaders(init.headers ?? {}),
          init.body === undefined
            ? (request) => request
            : HttpClientRequest.setBody(
                HttpBody.text(
                  typeof init.body === "string" ? init.body : JSON.stringify(init.body),
                  "application/json",
                ),
              ),
        ),
      );
    return {
      origin,
      spawned: () => NodeFS.existsSync(spawnMarker),
      received,
      bearerTokenReads: () => bearerTokenReads,
      hung,
      upstreamStreamClosed,
      releaseStalledBody,
      runtimeMode,
      threadPlacement,
      saveMcpServers,
      streamSubscriptions: () => streamSubscriptions,
      call,
      shared: Context.get(services, SharedMcpServers.SharedMcpServers),
    };
  });
const fixture = makeFixture();

const asAgent = { authorization: `Bearer ${AGENT_TOKEN}` };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.effect(
  "forwards agent requests with the saved token and passes responses through untouched",
  () =>
    Effect.gen(function* () {
      const { call, received } = yield* fixture;
      const probe = yield* call("/mcp/servers/executor", {
        body: modernRpc("server/discover"),
        headers: { ...asAgent, ...modernHeaders("server/discover") },
      });
      expect(probe.status).toBe(400);
      expect(yield* probe.text).toBe("");
      expect(received.splice(0).map(({ body }) => JSON.parse(body).method)).toEqual([
        "server/discover",
      ]);

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

it.effect("relays legacy skills capability, manifest, directory, and content verbatim", () =>
  Effect.gen(function* () {
    const { call, received } = yield* fixture;
    const initialize =
      '{ "jsonrpc":"2.0", "id":0, "method":"initialize", "params":{"protocolVersion":"2025-06-18","capabilities":{"extensions":{"io.modelcontextprotocol/skills":{}}},"clientInfo":{"name":"fixture-client","version":"1"}} }';
    const response = yield* call("/mcp/servers/skills", { body: initialize, headers: asAgent });
    expect(response.status).toBe(200);
    expect(yield* response.json).toMatchObject({ result: { capabilities: SKILL_CAPABILITIES } });

    const session = { ...asAgent, "mcp-session-id": response.headers["mcp-session-id"]! };
    const results = [
      [rpc("skills/list"), { skills: [SKILL_ENTRY] }],
      [rpc("skills/get", { uri: SKILL_URI }), { skill: SKILL_ENTRY }],
      [rpc("resources/directory/read", { uri: SKILL_DIR }), { resources: SKILL_DIRECTORY }],
      [rpc("resources/read", { uri: SKILL_URI }), { contents: SKILL_CONTENTS }],
    ] as const;
    let listedDigest: string | undefined;
    for (const [body, result] of results) {
      const reply = yield* call("/mcp/servers/skills", { body, headers: session });
      expect(reply.status).toBe(200);
      const payload = yield* reply.text;
      expect(payload).toBe(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      if (body.method === "skills/list") {
        listedDigest = JSON.parse(payload).result.skills[0].resources[0].digest;
      } else if (body.method === "resources/read") {
        expect(skillDigest(JSON.parse(payload).result.contents[0].text)).toBe(listedDigest);
      }
    }
    expect(received.map(({ body }) => body)).toEqual([
      initialize,
      ...results.map(([body]) => JSON.stringify(body)),
    ]);
    expect(received.map(({ headers }) => headers.authorization)).toEqual(
      Array(5).fill(`Bearer ${UPSTREAM_TOKEN}`),
    );
  }),
);

it.effect(
  "forwards modern routing headers and upstream protocol errors without leaking headers",
  () =>
    Effect.gen(function* () {
      const { call, received } = yield* fixture;
      for (const [method, name, result] of [
        ["server/discover", undefined, { capabilities: SKILL_CAPABILITIES }],
        ["skills/list", undefined, { skills: [SKILL_ENTRY] }],
        ["resources/read", SKILL_URI, { contents: SKILL_CONTENTS }],
      ] as const) {
        const body = modernRpc(method, name === undefined ? undefined : { uri: name });
        const headers = modernHeaders(method, name);
        const response = yield* call("/mcp/servers/skills", {
          body,
          headers: {
            ...asAgent,
            ...headers,
            "Mcp-Param-X": "opaque",
            "Mcp-Param-Project_Id": "fixture-project",
            "Mcp-Param-Region.Code": "test-region",
            cookie: "t3_session=browser-secret",
            "x-forwarded-for": "203.0.113.9",
            origin: "https://agent.example",
            "mcp-param-": "not-a-parameter",
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers["mcp-protocol-version"]).toBe(MODERN_VERSION);
        expect(yield* response.json).toMatchObject({
          result: { resultType: "complete", ...result },
        });
        expect(received.at(-1)).toMatchObject({
          body: JSON.stringify(body),
          headers: {
            ...headers,
            "mcp-param-x": "opaque",
            "mcp-param-project_id": "fixture-project",
            "mcp-param-region.code": "test-region",
            authorization: `Bearer ${UPSTREAM_TOKEN}`,
          },
        });
        for (const stripped of ["cookie", "x-forwarded-for", "origin", "mcp-param-"]) {
          expect(received.at(-1)?.headers).not.toHaveProperty(stripped);
        }
      }

      const unsupported = "2099-01-01";
      const refused = yield* call("/mcp/servers/skills", {
        body: modernRpc("server/discover", {}, unsupported),
        headers: { ...asAgent, ...modernHeaders("server/discover", undefined, unsupported) },
      });
      expect(refused.status).toBe(400);
      expect(yield* refused.text).toBe(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32022,"message":"Unsupported protocol version"}}',
      );
    }),
);

it.effect("discovers and reads skills against Effect's strict modern HTTP transport", () =>
  Effect.gen(function* () {
    const { call } = yield* makeFixture({ realSkills: true });
    const send = (method: string, uri?: string, name?: string) =>
      call("/mcp/servers/effect-skills", {
        body: modernRpc(method, uri === undefined ? undefined : { uri }),
        headers: { ...asAgent, ...modernHeaders(method, name) },
      });
    const mismatched = yield* send("resources/read", SKILL_URI, `${SKILL_URI}.wrong`);
    expect(mismatched.status).toBe(400);
    expect(yield* mismatched.json).toMatchObject({ error: { code: -32020 } });

    for (const [method, uri, name, result] of [
      [
        "server/discover",
        undefined,
        undefined,
        {
          supportedVersions: expect.arrayContaining([MODERN_VERSION]),
          capabilities: { resources: {}, extensions: SKILL_CAPABILITIES.extensions },
        },
      ],
      ["skills/list", undefined, undefined, { skills: [SKILL_ENTRY] }],
      ["skills/get", SKILL_URI, undefined, { skill: SKILL_ENTRY }],
      ["resources/read", SKILL_URI, SKILL_URI, { contents: SKILL_CONTENTS }],
    ] as const) {
      const response = yield* send(method, uri, name);
      expect(response.status, method).toBe(200);
      expect(response.headers["mcp-session-id"]).toBeUndefined();
      expect(yield* response.json).toMatchObject({
        id: 1,
        result: { resultType: "complete", ...result },
      });
    }
  }),
);

it.effect("relays skill catalog changes on a subscription until the caller disconnects", () =>
  Effect.gen(function* () {
    const { call, upstreamStreamClosed } = yield* fixture;
    const method = "subscriptions/listen";
    const response = yield* call("/mcp/servers/skills", {
      body: modernRpc(method),
      headers: { ...asAgent, ...modernHeaders(method) },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(
      yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.take(2),
        Stream.runCollect,
      ),
    ).toEqual(SKILL_CHANGED.trimEnd().split("\n").concat(""));
    yield* Deferred.await(upstreamStreamClosed);
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
        method === "POST" && rpcMethod !== "notifications/initialized"
          ? 200
          : mode === null
            ? 503
            : 403,
      );
      expect(yield* response.text).toContain(
        mode === null ? "could not read this thread" : "only works in threads with Full access",
      );
    }
  }),
);

it.effect("offers and runs shared tools only for threads in full access", () =>
  Effect.gen(function* () {
    const { call, received, runtimeMode } = yield* fixture;
    const send = (body: unknown, headers: Record<string, string> = asAgent) =>
      call("/mcp/servers/skills", { body, headers }).pipe(
        Effect.flatMap((response) => response.json),
      );
    const execute = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute" } };
    const refused = {
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32000,
        message:
          "Skills only works in threads with Full access. Switch this thread to Full access, then use Restart agent.",
      },
    };

    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      yield* Ref.set(runtimeMode, mode);
      expect(
        yield* send(rpc("initialize", {}, 0), {
          ...asAgent,
          "Mcp-Method": "tools/call",
          "Mcp-Name": "danger",
          "Mcp-Param-Id": "1",
        }),
      ).toMatchObject({
        result: { capabilities: SKILL_CAPABILITIES, serverInfo: { name: "Fixture" } },
      });
      expect(received.at(-1)?.headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
      for (const stripped of ["mcp-method", "mcp-name", "mcp-param-id"]) {
        expect(received.at(-1)?.headers).not.toHaveProperty(stripped);
      }
      const requestsBeforeListing = received.length;
      for (const [method, field] of Object.entries({
        "tools/list": "tools",
        "prompts/list": "prompts",
        "resources/list": "resources",
        "resources/templates/list": "resourceTemplates",
        "skills/list": "skills",
      })) {
        expect(yield* send({ jsonrpc: "2.0", id: 1, method })).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { [field]: [] },
        });
      }
      expect(received).toHaveLength(requestsBeforeListing);
      expect(yield* send(execute)).toEqual(refused);
      for (const method of SKILL_READ_METHODS) {
        expect(yield* send({ ...execute, method })).toEqual(refused);
      }
      const spoofedHeaders = { ...asAgent, ...modernHeaders("initialize") };
      expect(yield* send({ ...execute, method: "resources/read" }, spoofedHeaders)).toEqual(
        refused,
      );
      for (const method of ["server/discover", "skills/list", "subscriptions/listen"]) {
        const response = yield* call("/mcp/servers/skills", {
          body: modernRpc(method),
          headers: asAgent,
        });
        expect(response.status).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store, no-transform");
        expect(yield* response.text).toBe("");
      }
      const batch = yield* call("/mcp/servers/skills", { body: [execute], headers: asAgent });
      expect(batch.status).toBe(403);
    }

    // A thread that can't be read reaches nothing, not even an unbound server's initialize.
    yield* Ref.set(runtimeMode, null);
    expect(yield* send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })).toMatchObject({
      error: { message: "Skills is unavailable because T3 Code could not read this thread." },
    });
    expect(yield* send(rpc("skills/list"))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { skills: [] },
    });
    const unreadableModern = yield* call("/mcp/servers/skills", {
      body: rpc("server/discover", { _meta: { [PROTOCOL_CLAIM]: null } }),
      headers: asAgent,
    });
    expect(unreadableModern.status).toBe(400);
    expect(yield* unreadableModern.text).toBe("");
    expect(received.map((request) => JSON.parse(request.body).method)).toEqual(
      Array(3).fill("initialize"),
    );

    yield* Ref.set(runtimeMode, "full-access");
    expect(yield* send(execute)).toEqual(FAILED_CALL);
  }),
);

it.effect("serves a bound server only to top-level threads of its projects, never upstream", () =>
  Effect.gen(function* () {
    const { call, received, threadPlacement } = yield* fixture;
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
    ]) {
      yield* Ref.set(threadPlacement, placement);
      expect(yield* send("initialize")).toEqual(refused);
      expect(yield* send("tools/call")).toEqual(refused);
      expect(yield* send("tools/list")).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
      expect(yield* send("skills/list")).toEqual({ jsonrpc: "2.0", id: 1, result: { skills: [] } });
      for (const method of SKILL_READ_METHODS) {
        expect(yield* send(method)).toEqual(refused);
      }
      const modern = yield* call("/mcp/servers/bound", {
        body: modernRpc("skills/list"),
        headers: asAgent,
      });
      expect(modern.status).toBe(400);
      expect(yield* modern.text).toBe("");
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

    const id = McpServerId.make("denied");
    const projectId = ProjectId.make("project:mcp-test");
    // Management admits the caller against this snapshot; a later lookup would see a different token.
    const authorized = {
      ...DEFAULT_SERVER_SETTINGS,
      mcpServers: { [id]: server(url, { projectIds: [projectId] }) },
    };
    const result = yield* Effect.gen(function* () {
      const management = yield* SharedMcpServerManagement.SharedMcpServerManagement;
      return yield* management.test(id, { projectId, subagent: false });
    }).pipe(
      Effect.provide(
        SharedMcpServerManagement.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ServerSettingsService.ServerSettingsService)({
                getSettings: Effect.succeed(authorized),
              }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.succeed(SharedMcpServers.SharedMcpServers, shared),
            ),
          ),
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Connected", tools: ["search", "execute"] });
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

    const sendAndWait = Effect.fnUntraced(function* (body: ReturnType<typeof rpc>) {
      const fiber = yield* send(body);
      expect(yield* Queue.take(hung)).toBe(JSON.stringify(body));
      return fiber;
    });
    const prompt = yield* Effect.forEach(
      [rpc("tools/list"), modernRpc("server/discover"), modernRpc("skills/list")],
      sendAndWait,
    );
    const onDemand = yield* Effect.forEach(
      ["tools/call", ...SKILL_READ_METHODS, "subscriptions/listen"].map((method) =>
        modernRpc(method),
      ),
      sendAndWait,
    );
    const getStream = yield* call("/mcp/servers/hang", {
      method: "GET",
      headers: { ...asAgent, accept: "text/event-stream" },
    }).pipe(Effect.forkChild);
    expect(yield* Queue.take(hung)).toBe("");
    yield* TestClock.adjust("4 seconds");
    expect(prompt.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true);
    yield* TestClock.adjust("1 second");
    for (const fiber of prompt) {
      expect(yield* (yield* Fiber.join(fiber)).json).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "Hang did not answer within 5 seconds." },
      });
    }
    yield* TestClock.adjust("10 minutes");
    const pending = [...onDemand, getStream];
    expect(pending.every((fiber) => fiber.pollUnsafe() === undefined)).toBe(true);
    yield* Fiber.interruptAll(pending);
  }),
);

it.effect("times out discovery when the upstream sends headers but stalls the body", () =>
  Effect.gen(function* () {
    const { call, hung, upstreamStreamClosed, releaseStalledBody } = yield* fixture;
    yield* Effect.addFinalizer(() => Deferred.succeed(releaseStalledBody, undefined));
    const method = "server/discover";
    const body = modernRpc(method);
    const pending = yield* call("/mcp/servers/stall-body", {
      body,
      headers: { ...asAgent, ...modernHeaders(method) },
    }).pipe(Effect.forkChild);

    expect(yield* Queue.take(hung)).toBe(JSON.stringify(body));
    yield* TestClock.adjust("4 seconds");
    expect(pending.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 second");
    const response = yield* Fiber.join(pending);
    expect(response.status).toBe(504);
    expect(yield* response.json).toMatchObject({
      id: 1,
      error: { code: -32000, message: "Stalled discovery did not answer within 5 seconds." },
    });
    yield* Deferred.await(upstreamStreamClosed);
  }),
);

it.effect("bridges a stdio server on the same route, with the same full-access gate", () =>
  Effect.gen(function* () {
    const { call, received, runtimeMode, spawned } = yield* fixture;
    const probe = yield* call("/mcp/servers/local", {
      body: modernRpc("server/discover"),
      headers: { ...asAgent, ...modernHeaders("server/discover") },
    });
    expect(probe.status).toBe(400);
    expect(yield* probe.text).toBe("");
    expect(spawned()).toBe(false);

    const initialize = yield* call("/mcp/servers/local", {
      body: { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
      headers: asAgent,
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers["cache-control"]).toBe("no-store, no-transform");
    const sessionId = initialize.headers["mcp-session-id"];
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(yield* initialize.json).toMatchObject({
      result: { capabilities: SKILL_CAPABILITIES, serverInfo: { name: "fake-stdio" } },
    });
    expect(spawned()).toBe(true);
    const session = { ...asAgent, "mcp-session-id": sessionId! };
    const send = (body: unknown) =>
      call("/mcp/servers/local", { body, headers: session }).pipe(
        Effect.flatMap((response) => response.json),
      );
    expect(yield* send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({
      result: { tools: [{ name: "echo" }, { name: "env" }, { name: "crash" }, { name: "ask" }] },
    });
    const echo = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    };
    expect(yield* send(echo)).toMatchObject({ id: 2, result: { content: [{ text: "hi" }] } });
    for (const [method, params, result] of [
      ["skills/list", undefined, { skills: [SKILL_ENTRY] }],
      ["skills/get", { uri: SKILL_URI }, { skill: SKILL_ENTRY }],
      ["resources/directory/read", { uri: SKILL_DIR }, { resources: SKILL_DIRECTORY }],
      ["resources/read", { uri: SKILL_URI }, { contents: SKILL_CONTENTS }],
    ] as const) {
      expect(yield* send(rpc(method, params))).toMatchObject({ id: 1, result });
    }

    yield* Ref.set(runtimeMode, "approval-required");
    expect(yield* send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    expect(yield* send(echo)).toMatchObject({
      error: { message: expect.stringContaining("Local only works in threads with Full access") },
    });
    yield* Ref.set(runtimeMode, "full-access");

    expect((yield* call("/mcp/servers/local", { method: "GET", headers: session })).status).toBe(
      405,
    );
    expect((yield* call("/mcp/servers/local", { method: "DELETE", headers: session })).status).toBe(
      200,
    );
    expect((yield* call("/mcp/servers/local", { body: echo, headers: session })).status).toBe(404);
    // Nothing went to the HTTP upstream.
    expect(received).toHaveLength(0);
  }),
);

it.effect("never starts a stdio server's process for a thread without full access", () =>
  Effect.gen(function* () {
    const { call, runtimeMode, spawned } = yield* fixture;
    yield* Ref.set(runtimeMode, "approval-required");
    const send = (body: unknown, sessionId?: string) =>
      call("/mcp/servers/tripwire", {
        body,
        headers: sessionId === undefined ? asAgent : { ...asAgent, "mcp-session-id": sessionId },
      });
    const initialize = yield* send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    const sessionId = initialize.headers["mcp-session-id"];
    expect(sessionId).toBe("supervised");
    expect(yield* initialize.json).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Tripwire", version: "0" },
      },
    });
    expect((yield* send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect(yield* (yield* send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    expect(yield* (yield* send(rpc("skills/list"))).json).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { skills: [] },
    });
    const probe = yield* send(modernRpc("server/discover"));
    expect(probe.status).toBe(400);
    expect(yield* probe.text).toBe("");
    for (const method of SKILL_READ_METHODS) {
      expect(yield* (yield* send(rpc(method))).json).toMatchObject({
        error: { code: -32000, message: expect.stringContaining("Full access") },
      });
    }
    expect(
      yield* (yield* send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "x" },
      })).json,
    ).toMatchObject({
      id: 2,
      error: {
        message:
          "Tripwire only works in threads with Full access. Switch this thread to Full access, then use Restart agent.",
      },
    });
    expect(spawned()).toBe(false);

    // After the switch, the handshake's session is unknown: 404 tells the harness to initialize again.
    yield* Ref.set(runtimeMode, "full-access");
    expect((yield* send({ jsonrpc: "2.0", id: 3, method: "tools/list" }, sessionId)).status).toBe(
      404,
    );
    expect(spawned()).toBe(false);
    yield* send({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }, sessionId);
    expect(spawned()).toBe(true);
  }),
);

type StdioEntryEdit = (entry: Record<string, unknown>) => Record<string, unknown> | undefined;
const staleStdioEdits: ReadonlyArray<readonly [string, StdioEntryEdit]> = [
  ["removed", () => undefined],
  ["turned off", (entry) => ({ ...entry, enabled: false })],
  ["given a new env value", (entry) => ({ ...entry, env: { T3_BRIDGE_TEST_SECRET: "rotated" } })],
  ["given new args", (entry) => ({ ...entry, args: [...(entry.args as Array<string>), "--v2"] })],
];

/** Opens two sessions on `local`, edits its entry, and expects both processes gone without a call. */
const expectEditStopsProcesses = (
  { call, saveMcpServers }: Effect.Success<ReturnType<typeof makeFixture>>,
  edit: StdioEntryEdit,
) =>
  Effect.gen(function* () {
    const local = McpServerId.make("local");
    const paused = McpServerId.make("paused");
    const askPid = (session: Record<string, string>) =>
      call("/mcp/servers/local", {
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pid" } },
        headers: session,
      }).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((answer) =>
          Number(
            (answer as { result: { content: Array<{ text: string }> } }).result.content[0]!.text,
          ),
        ),
      );
    const open = Effect.gen(function* () {
      const initialize = yield* call("/mcp/servers/local", {
        body: { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
        headers: asAgent,
      });
      const session = { ...asAgent, "mcp-session-id": initialize.headers["mcp-session-id"]! };
      return { session, pid: yield* askPid(session) };
    });
    const first = yield* open;
    const second = yield* open;
    const pids = [first.pid, second.pid];

    // Editing another entry leaves them running: the same process still answers.
    yield* saveMcpServers((servers) => ({
      ...servers,
      [paused]: { ...servers[paused]!, label: "Paused" },
    }));
    expect(yield* askPid(first.session)).toBe(first.pid);
    expect(pids.every(alive)).toBe(true);

    yield* saveMcpServers((servers) => {
      const next = { ...servers };
      const entry = edit(next[local] as unknown as Record<string, unknown>);
      if (entry === undefined) delete next[local];
      else next[local] = entry as unknown as (typeof servers)[typeof local];
      return next;
    });
    yield* Effect.promise(() =>
      expect.poll(() => pids.some(alive), { timeout: 3000, interval: 20 }).toBe(false),
    );
  });

it.effect.each(staleStdioEdits)(
  "stops a stdio server's processes as soon as its entry is %s, without waiting for a call",
  ([, edit]) => fixture.pipe(Effect.flatMap((harness) => expectEditStopsProcesses(harness, edit))),
);

it.effect("restarts the settings watcher when its stream fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeFixture({ brokenSettingsStream: true });
    yield* Effect.promise(() =>
      expect.poll(harness.streamSubscriptions, { timeout: 3000, interval: 10 }).toBe(1),
    );
    yield* TestClock.adjust("1 second");
    yield* Effect.promise(() =>
      expect.poll(harness.streamSubscriptions, { timeout: 3000, interval: 10 }).toBe(2),
    );
    yield* expectEditStopsProcesses(harness, () => undefined);
  }),
);

it.effect(
  "rejects skill discovery when a server is disabled, removed, or from a newer version",
  () =>
    Effect.gen(function* () {
      const { call, saveMcpServers, received, spawned } = yield* fixture;
      const tripwire = McpServerId.make("tripwire");
      yield* saveMcpServers((servers) => ({
        ...servers,
        [tripwire]: { ...servers[tripwire]!, enabled: false },
      }));
      const expectTurnedOff = Effect.fnUntraced(function* (name: string) {
        for (const body of [rpc("skills/list"), modernRpc("skills/list")]) {
          const response = yield* call(`/mcp/servers/${name}`, { body, headers: asAgent });
          expect(response.status).toBe(200);
          expect(yield* response.json).toMatchObject({
            id: 1,
            error: {
              code: -32000,
              message: `MCP server "${name}" is turned off or removed in Settings.`,
            },
          });
        }
      });
      for (const name of ["future", "paused", tripwire]) {
        yield* expectTurnedOff(name);
      }
      yield* saveMcpServers((servers) => {
        const next = { ...servers };
        delete next[tripwire];
        return next;
      });
      yield* expectTurnedOff(tripwire);
      expect(received).toEqual([]);
      expect(spawned()).toBe(false);
    }),
);
