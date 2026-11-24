// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off globalDate:off
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { StdioMcpBridgeCore, type StdioBridgeRequest, testStdioServer } from "./StdioMcpBridge.ts";

const FAKE = fileURLToPath(new URL("./testdata/fakeStdioMcpServer.mjs", import.meta.url));
const server = (env: Record<string, string> = {}): StdioBridgeRequest["server"] => ({
  command: process.execPath,
  args: [FAKE],
  env,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const cores: StdioMcpBridgeCore[] = [];
const makeCore = (options?: ConstructorParameters<typeof StdioMcpBridgeCore>[0]) => {
  const core = new StdioMcpBridgeCore({ killGraceMs: 200, ...options });
  cores.push(core);
  return core;
};
afterEach(() => {
  for (const core of cores.splice(0)) core.closeAll();
});

const harness = (
  core: StdioMcpBridgeCore,
  config = server(),
  owner = "thread-a",
  serverId = "exec",
) => {
  const post = (sessionId: string | undefined, message: unknown) =>
    core.handle({
      serverId,
      server: config,
      owner,
      method: "POST",
      sessionId,
      body: JSON.stringify(message),
    });
  const initialize = async () => {
    const response = await post(undefined, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    return { response, sessionId: response.headers["mcp-session-id"] };
  };
  return { post, initialize };
};
const body = (response: { body: string }) => JSON.parse(response.body);

describe("StdioMcpBridgeCore", () => {
  it("bridges initialize, tools/list and tools/call to a server that rejects early requests", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core, server({ FAKE_MCP_INIT_DELAY_MS: "300" }));
    const { response, sessionId } = await initialize();
    expect(response.status).toBe(200);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body(response).result.serverInfo.name).toBe("fake-stdio");

    expect(
      (await post(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" })).status,
    ).toBe(202);
    const listed = await post(sessionId, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(body(listed).result.tools.map((tool: { name: string }) => tool.name)).toContain("echo");
    // Concurrent calls are matched to their own ids.
    const [a, b] = await Promise.all([
      post(sessionId, {
        jsonrpc: "2.0",
        id: "a",
        method: "tools/call",
        params: { name: "echo", arguments: { text: "one" } },
      }),
      post(sessionId, {
        jsonrpc: "2.0",
        id: "b",
        method: "tools/call",
        params: { name: "echo", arguments: { text: "two" } },
      }),
    ]);
    expect(body(a)).toMatchObject({ id: "a", result: { content: [{ text: "one" }], early: 0 } });
    expect(body(b)).toMatchObject({ id: "b", result: { content: [{ text: "two" }], early: 0 } });
  });

  it("answers GET with 405 and unknown, foreign or missing sessions without reaching a process", async () => {
    const core = makeCore();
    const a = harness(core);
    const { sessionId } = await a.initialize();
    expect(
      (
        await core.handle({
          serverId: "exec",
          server: server(),
          owner: "thread-a",
          method: "GET",
          sessionId,
          body: "",
        })
      ).status,
    ).toBe(405);
    const call = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await a.post("not-a-session", call)).status).toBe(404);
    expect((await a.post(undefined, call)).status).toBe(400);
    // Another thread can't ride this thread's session, nor can another server id.
    expect((await harness(core, server(), "thread-b").post(sessionId, call)).status).toBe(404);
    expect((await harness(core, server(), "thread-a", "other").post(sessionId, call)).status).toBe(
      404,
    );
    expect(core.sessionCount).toBe(1);
  });

  it("stops the process on DELETE, and the session is gone", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core);
    const { sessionId } = await initialize();
    const [pid] = core.pids();
    expect(alive(pid!)).toBe(true);
    const deleted = await core.handle({
      serverId: "exec",
      server: server(),
      owner: "thread-a",
      method: "DELETE",
      sessionId,
      body: "",
    });
    expect(deleted.status).toBe(200);
    await until(() => !alive(pid!));
    expect((await post(sessionId, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(
      404,
    );
  });

  it("fails in-flight calls when the process crashes, then 404s so the harness initializes again", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core);
    const { sessionId } = await initialize();
    const crashed = await post(sessionId, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "crash" },
    });
    expect(body(crashed)).toMatchObject({ id: 7, error: { code: -32000 } });
    expect(body(crashed).error.message).toMatch(/exited \(code 3\)/);
    expect((await post(sessionId, { jsonrpc: "2.0", id: 8, method: "tools/list" })).status).toBe(
      404,
    );
    const again = await initialize();
    expect(again.response.status).toBe(200);
    expect(again.sessionId).not.toBe(sessionId);
  });

  it("times out an unanswered initialize and stops the process", async () => {
    const core = makeCore({ initializeTimeoutMs: 300 });
    const { initialize } = harness(core, server({ FAKE_MCP_NEVER_INIT: "1" }));
    const pending = initialize();
    await until(() => core.pids().length === 1);
    const [pid] = core.pids();
    const { response, sessionId } = await pending;
    expect(sessionId).toBeUndefined();
    expect(body(response)).toMatchObject({ id: 0, error: { code: -32000 } });
    expect(body(response).error.message).toMatch(/did not answer initialize/);
    await until(() => !alive(pid!));
    expect(core.sessionCount).toBe(0);
  });

  it("caps sessions per server by stopping the least recently used", async () => {
    const core = makeCore({ maxSessionsPerServer: 2 });
    const first = await harness(core, server(), "t1").initialize();
    const second = await harness(core, server(), "t2").initialize();
    const [oldest] = core.pids();
    await harness(core, server(), "t2").post(second.sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    await harness(core, server(), "t3").initialize();
    expect(core.sessionCount).toBe(2);
    await until(() => !alive(oldest!));
    expect(
      (
        await harness(core, server(), "t1").post(first.sessionId, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        })
      ).status,
    ).toBe(404);
  });

  it("retires a session whose command, args or env changed in Settings", async () => {
    const core = makeCore();
    const { sessionId } = await harness(core, server({ A: "1" })).initialize();
    const changed = await harness(core, server({ A: "2" })).post(sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(changed.status).toBe(404);
    expect(core.sessionCount).toBe(0);
  });

  it("refuses server-initiated requests, since there is no stream back to the harness", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core);
    const { sessionId } = await initialize();
    const asked = await post(sessionId, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ask" },
    });
    expect(body(asked)).toMatchObject({ id: 3, result: { refused: -32601 } });
  });

  it("gives the process only the configured env plus a few basics, not this server's secrets", async () => {
    process.env.T3_BRIDGE_TEST_SECRET = "do-not-leak";
    try {
      const core = makeCore();
      const { post, initialize } = harness(core, server({ FAKE_MCP_CONFIGURED: "yes" }));
      const { sessionId } = await initialize();
      const answered = await post(sessionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "env" },
      });
      expect(JSON.parse(body(answered).result.content[0].text)).toEqual({
        secret: null,
        configured: "yes",
      });
    } finally {
      delete process.env.T3_BRIDGE_TEST_SECRET;
    }
  });

  it("reports an unstartable command as an MCP error", async () => {
    const core = makeCore();
    const { response, sessionId } = await harness(core, {
      command: "/nonexistent/mcp-server",
      args: [],
      env: {},
    }).initialize();
    expect(sessionId).toBeUndefined();
    expect(body(response)).toMatchObject({ id: 0, error: { code: -32000 } });
    expect(core.sessionCount).toBe(0);
  });

  it("closeAll stops every process", async () => {
    const core = makeCore();
    await harness(core, server(), "t1").initialize();
    await harness(core, server(), "t2").initialize();
    const pids = core.pids();
    core.closeAll();
    await until(() => pids.every((pid) => !alive(pid)));
  });
});

describe("testStdioServer", () => {
  it("connects, lists tools and leaves no process behind", async () => {
    const result = await testStdioServer(server());
    expect(result).toEqual({
      _tag: "Connected",
      serverName: "fake-stdio",
      tools: ["echo", "env", "crash", "ask"],
    });
  });

  it("reports a timeout", async () => {
    expect(await testStdioServer(server({ FAKE_MCP_NEVER_INIT: "1" }), 300)).toEqual({
      _tag: "Unreachable",
      timedOut: true,
    });
  });
});
