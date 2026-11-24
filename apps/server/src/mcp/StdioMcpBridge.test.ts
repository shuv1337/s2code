// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalJsonInEffect:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { McpServerId, type ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";

import {
  make as makeStdioMcpBridge,
  StdioMcpBridgeCore,
  type StdioBridgeRequest,
  testStdioServer,
} from "./StdioMcpBridge.ts";

const FAKE = NodeURL.fileURLToPath(new URL("./testdata/fakeStdioMcpServer.mjs", import.meta.url));
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
const until = (check: () => boolean, timeout = 3000) =>
  expect.poll(check, { timeout, interval: 20 }).toBe(true);

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
  const post = (sessionId: string | undefined, message: unknown, signal?: AbortSignal) =>
    core.handle(
      {
        serverId,
        server: config,
        owner,
        method: "POST",
        sessionId,
        body: JSON.stringify(message),
      },
      signal,
    );
  const initialize = async (signal?: AbortSignal) => {
    const response = await post(
      undefined,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      },
      signal,
    );
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

  it("caps processes across servers and never stops one with a call in flight", async () => {
    const core = makeCore({ maxSessions: 2 });
    const busy = await harness(core, server(), "t1", "a").initialize();
    await harness(core, server(), "t2", "b").initialize();
    const [busyPid, idlePid] = core.pids();
    const call = harness(core, server(), "t1", "a").post(busy.sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hang" },
    });

    const third = await harness(core, server(), "t3", "c").initialize();
    expect(third.response.status).toBe(200);
    expect(core.sessionCount).toBe(2);
    await until(() => !alive(idlePid!));
    expect(alive(busyPid!)).toBe(true);

    // Every remaining session is busy or newest; with the busy one alone left over, a fourth waits.
    const hung = harness(core, server(), "t3", "c").post(third.sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hang" },
    });
    const refused = await harness(core, server(), "t4", "d").initialize();
    expect(refused.sessionId).toBeUndefined();
    expect(body(refused.response).error.message).toMatch(/Too many MCP server processes/);
    expect(core.sessionCount).toBe(2);

    core.closeAll();
    expect(body(await call).error.message).toMatch(/stopped before answering/);
    expect(body(await hung).error.message).toMatch(/stopped before answering/);
  });

  it("closes a session whose server writes an oversized message (unterminated, terminated, or multibyte UTF-8)", async () => {
    // Unterminated frame past byte limit.
    {
      const core = makeCore({ maxMessageBytes: 1024 });
      const { post, initialize } = harness(core, server());
      const { sessionId } = await initialize();
      const [pid] = core.pids();
      const flooded = await post(sessionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "flood", arguments: { chars: 4096 } },
      });
      expect(body(flooded).error.message).toMatch(/over 1024 bytes/);
      await until(() => !alive(pid!));
      expect(core.sessionCount).toBe(0);
    }

    // Complete newline-terminated frame exceeding limit in its final chunk: must close and NOT parse.
    {
      const core = makeCore({ maxMessageBytes: 1024 });
      const { post, initialize } = harness(core, server());
      const { sessionId } = await initialize();
      const [pid] = core.pids();
      const flooded = await post(sessionId, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "flood", arguments: { chars: 1200, terminated: true } },
      });
      expect(body(flooded)).toMatchObject({ id: 2, error: { code: -32000 } });
      expect(body(flooded).error.message).toMatch(/over 1024 bytes/);
      await until(() => !alive(pid!));
      expect(core.sessionCount).toBe(0);
    }

    // Multibyte UTF-8 frame: 500 CJK chars (UTF-16 length < 1024) = 1500 UTF-8 bytes > 1024.
    {
      const core = makeCore({ maxMessageBytes: 1024 });
      const { post, initialize } = harness(core, server());
      const { sessionId } = await initialize();
      const [pid] = core.pids();
      const flooded = await post(sessionId, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "flood", arguments: { chars: 500, char: "中", terminated: true } },
      });
      expect(body(flooded)).toMatchObject({ id: 3, error: { code: -32000 } });
      expect(body(flooded).error.message).toMatch(/over 1024 bytes/);
      await until(() => !alive(pid!));
      expect(core.sessionCount).toBe(0);
    }
  });

  it("keeps a session alive past idleTimeoutMs while a call is in flight, then closes once idle", async () => {
    const core = makeCore({ idleTimeoutMs: 120 });
    const { post, initialize } = harness(core, server());
    const { sessionId } = await initialize();
    const [pid] = core.pids();
    const slow = await post(sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "after-idle-window", delayMs: 280 } },
    });
    expect(body(slow)).toMatchObject({
      id: 1,
      result: { content: [{ text: "after-idle-window" }] },
    });
    expect(core.sessionCount).toBe(1);
    await until(() => core.sessionCount === 0 && !alive(pid!));
  });

  it("clears pending state when a request is aborted and closes aborted initializations", async () => {
    const core = makeCore({ maxSessions: 1, idleTimeoutMs: 150 });
    const first = harness(core, server(), "t1", "a");
    const { sessionId } = await first.initialize();
    const [firstPid] = core.pids();

    // Abort a hung call: busy clears, duplicate-id is freed, and LRU/idle can reclaim the session.
    const callAbort = new AbortController();
    const hung = first.post(
      sessionId,
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "hang" } },
      callAbort.signal,
    );
    callAbort.abort();
    expect(body(await hung)).toMatchObject({ id: 9, error: { code: -32000 } });

    // Reusing the same id works immediately (no stuck duplicate-id error).
    const reused = await first.post(sessionId, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "ok" } },
    });
    expect(body(reused)).toMatchObject({ id: 9, result: { content: [{ text: "ok" }] } });

    // Because busy is cleared, another session can evict it via LRU.
    const second = await harness(core, server(), "t2", "b").initialize();
    expect(second.sessionId).toBeDefined();
    await until(() => !alive(firstPid!));
    core.closeAll();

    // Aborting an in-flight initialize closes the half-initialized session without leaking a process.
    const initAbort = new AbortController();
    const pendingInit = harness(core, server({ FAKE_MCP_NEVER_INIT: "1" }), "t3", "c").initialize(
      initAbort.signal,
    );
    await until(() => core.pids().length === 1);
    const [halfPid] = core.pids();
    initAbort.abort();
    const cancelled = await pendingInit;
    expect(cancelled.sessionId).toBeUndefined();
    expect(body(cancelled.response)).toMatchObject({ id: 0, error: { code: -32000 } });
    await until(() => !alive(halfPid!));
    expect(core.sessionCount).toBe(0);
  });

  it("counts retiring processes against the session cap until they actually exit", async () => {
    const core = makeCore({ maxSessions: 1, killGraceMs: 250 });
    const first = harness(core, server({ FAKE_MCP_IGNORE_SIGTERM: "1" }), "t1", "a");
    const { sessionId } = await first.initialize();
    const [firstPid] = core.pids();
    expect(alive(firstPid!)).toBe(true);

    // Close moves the SIGTERM-ignoring child into retiring until SIGKILL ends it.
    await core.handle({
      serverId: "a",
      server: server({ FAKE_MCP_IGNORE_SIGTERM: "1" }),
      owner: "t1",
      method: "DELETE",
      sessionId,
      body: "",
    });
    expect(core.sessionCount).toBe(0);
    expect(core.retiringCount).toBe(1);

    // A replacement waits for the retiring process to exit before spawning, then succeeds.
    const second = await harness(core, server(), "t2", "b").initialize();
    expect(second.sessionId).toBeDefined();
    expect(alive(firstPid!)).toBe(false);
    expect(core.retiringCount).toBe(0);
    expect(core.sessionCount).toBe(1);
  });

  it("waits for an existing retiring child before evicting a healthy idle session", async () => {
    const core = makeCore({ maxSessions: 2, killGraceMs: 250 });
    const retiring = await harness(
      core,
      server({ FAKE_MCP_IGNORE_SIGTERM: "1" }),
      "t1",
      "a",
    ).initialize();
    const healthy = await harness(core, server(), "t2", "b").initialize();
    const [retiringPid, healthyPid] = core.pids();

    await core.handle({
      serverId: "a",
      server: server({ FAKE_MCP_IGNORE_SIGTERM: "1" }),
      owner: "t1",
      method: "DELETE",
      sessionId: retiring.sessionId,
      body: "",
    });
    expect(core.sessionCount).toBe(1);
    expect(core.retiringCount).toBe(1);

    // Global cap is 2 (1 retiring + 1 active idle); initializing a third waits on retiring instead of evicting healthy.
    const third = await harness(core, server(), "t3", "c").initialize();
    expect(third.sessionId).toBeDefined();
    expect(alive(retiringPid!)).toBe(false);
    expect(alive(healthyPid!)).toBe(true);
    expect(core.sessionCount).toBe(2);
    expect(core.retiringCount).toBe(0);

    const healthyReply = await harness(core, server(), "t2", "b").post(healthy.sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "still-healthy" } },
    });
    expect(body(healthyReply)).toMatchObject({
      id: 1,
      result: { content: [{ text: "still-healthy" }] },
    });
  });

  it("invalidates a queued initialize waiter on reconcile so it never spawns an obsolete server", async () => {
    const marker = NodePath.join(NodeOS.tmpdir(), `s2code-queued-init-${NodeCrypto.randomUUID()}`);
    const core = makeCore({ maxSessions: 1, killGraceMs: 300 });
    const first = await harness(
      core,
      server({ FAKE_MCP_IGNORE_SIGTERM: "1" }),
      "t1",
      "a",
    ).initialize();
    await core.handle({
      serverId: "a",
      server: server({ FAKE_MCP_IGNORE_SIGTERM: "1" }),
      owner: "t1",
      method: "DELETE",
      sessionId: first.sessionId,
      body: "",
    });
    expect(core.retiringCount).toBe(1);

    const tripwire: StdioBridgeRequest["server"] = {
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`],
      env: {},
    };
    const queued = harness(core, tripwire, "t2", "b").initialize();
    core.reconcile({} as ServerSettings["mcpServers"]);
    const result = await queued;
    expect(result.sessionId).toBeUndefined();
    expect(body(result.response)).toMatchObject({ id: 0, error: { code: -32000 } });
    expect(body(result.response).error.message).toMatch(/removed in Settings/);

    await until(() => core.retiringCount === 0);
    expect(NodeFS.existsSync(marker)).toBe(false);
    expect(core.sessionCount).toBe(0);
  });

  it("ignores late responses to aborted requests even when the caller reuses the same id", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core, server());
    const { sessionId } = await initialize();

    const firstAbort = new AbortController();
    const firstCall = post(
      sessionId,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "first", hold: true } },
      },
      firstAbort.signal,
    );
    // Confirm the child has received the first call before aborting.
    const held = await post(sessionId, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "held-count" },
    });
    expect(body(held)).toMatchObject({ id: 99, result: { count: 1 } });

    firstAbort.abort();
    expect(body(await firstCall)).toMatchObject({ id: 1, error: { code: -32000 } });

    // Reusing id: 1 immediately flushes the old held reply first, then sends the new reply.
    const replacement = await post(sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "release-and-echo", arguments: { text: "second" } },
    });
    expect(body(replacement)).toMatchObject({
      id: 1,
      result: { content: [{ text: "second" }] },
    });
  });

  it("translates notifications/cancelled requestId to wire IDs and drops unmapped IDs", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core, server());
    const { sessionId } = await initialize();

    // Hold two concurrent calls with caller IDs "call-a" and "call-b".
    const callA = post(sessionId, {
      jsonrpc: "2.0",
      id: "call-a",
      method: "tools/call",
      params: { name: "echo", arguments: { text: "alpha", hold: true } },
    });
    const callB = post(sessionId, {
      jsonrpc: "2.0",
      id: "call-b",
      method: "tools/call",
      params: { name: "echo", arguments: { text: "beta", hold: true } },
    });
    expect(
      body(
        await post(sessionId, {
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "held-count" },
        }),
      ),
    ).toMatchObject({ id: 99, result: { count: 2 } });

    // An unmapped caller ID (even one colliding with call B's numeric wire ID 3) must be dropped.
    expect(
      (
        await post(sessionId, {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 3, reason: "spurious" },
        })
      ).status,
    ).toBe(202);

    // Cancelling call A by its caller ID reaches call A's wire ID and cancels only call A.
    expect(
      (
        await post(sessionId, {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "call-a", reason: "user cancelled" },
        })
      ).status,
    ).toBe(202);
    expect(body(await callA)).toMatchObject({
      id: "call-a",
      error: { code: -32800, message: "cancelled" },
    });

    // Release call B and verify it answers cleanly and only call A's wire ID (2) was cancelled.
    const flushed = await post(sessionId, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "release-and-echo", arguments: { text: "done" } },
    });
    expect(body(flushed)).toMatchObject({ id: 100, result: { content: [{ text: "done" }] } });
    expect(body(await callB)).toMatchObject({
      id: "call-b",
      result: { content: [{ text: "beta" }] },
    });
    const cancelled = await post(sessionId, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "cancelled-ids" },
    });
    expect(body(cancelled)).toMatchObject({ id: 101, result: { ids: [2] } });
  });

  it("invalidates a free-slot reservation across the await microtask gap on closeAll and reconcile", async () => {
    for (const invalidate of ["closeAll", "reconcile"] as const) {
      const marker = NodePath.join(
        NodeOS.tmpdir(),
        `s2code-sync-init-${invalidate}-${NodeCrypto.randomUUID()}`,
      );
      const core = makeCore({ maxSessions: 2 });
      const tripwire: StdioBridgeRequest["server"] = {
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`],
        env: {},
      };
      const pending = harness(core, tripwire, "t1", "b").initialize();
      if (invalidate === "closeAll") core.closeAll("shutting down");
      else core.reconcile({} as ServerSettings["mcpServers"]);
      const result = await pending;
      expect(result.sessionId).toBeUndefined();
      expect(body(result.response)).toMatchObject({ id: 0, error: { code: -32000 } });
      expect(core.sessionCount).toBe(0);
      expect(NodeFS.existsSync(marker)).toBe(false);
    }
  });

  it("restores top-level caller id without re-serializing unrelated payload values like 64-bit ints", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core, server());
    const { sessionId } = await initialize();

    const response = await post(sessionId, {
      jsonrpc: "2.0",
      id: "big-req",
      method: "tools/call",
      params: { name: "big-int" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('"id":"big-req"');
    expect(response.body).toContain('"big":9007199254740993');
    expect(response.body).toContain('"nested":{"id":999}');

    // Duplicate top-level "id" keys follow JSON.parse last-key-wins semantics.
    const dup = await post(sessionId, {
      jsonrpc: "2.0",
      id: "dup-req",
      method: "tools/call",
      params: { name: "dup-id" },
    });
    expect(dup.status).toBe(200);
    expect(body(dup)).toEqual({ jsonrpc: "2.0", id: "dup-req", result: { ok: true } });
  });

  it("rejects lossy >2^53 numeric request ids and drops lossy cancellations without colliding", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core, server());
    const { sessionId } = await initialize();

    // Lossy numeric request ID 9007199254740993 is rejected with -32600 instead of collapsing to 9007199254740992.
    const lossyRequest = await core.handle({
      serverId: "exec",
      server: server(),
      owner: "thread-a",
      method: "POST",
      sessionId,
      body: '{"jsonrpc":"2.0","id":9007199254740993,"method":"tools/list"}',
    });
    expect(body(lossyRequest)).toMatchObject({ id: null, error: { code: -32600 } });

    // Hold a call with exact numeric id 9007199254740992 (2^53).
    const pending = core.handle({
      serverId: "exec",
      server: server(),
      owner: "thread-a",
      method: "POST",
      sessionId,
      body: '{"jsonrpc":"2.0","id":9007199254740992,"method":"tools/call","params":{"name":"echo","arguments":{"text":"safe","hold":true}}}',
    });
    expect(
      body(
        await post(sessionId, {
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "held-count" },
        }),
      ),
    ).toMatchObject({ id: 99, result: { count: 1 } });

    // A lossy cancellation for 9007199254740993 must be dropped and MUST NOT cancel 9007199254740992.
    const lossyCancel = await core.handle({
      serverId: "exec",
      server: server(),
      owner: "thread-a",
      method: "POST",
      sessionId,
      body: '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9007199254740993}}',
    });
    expect(lossyCancel.status).toBe(202);

    await post(sessionId, {
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "release-and-echo", arguments: { text: "flushed" } },
    });
    expect(body(await pending)).toMatchObject({
      id: 9007199254740992,
      result: { content: [{ text: "safe" }] },
    });
    expect(
      body(
        await post(sessionId, {
          jsonrpc: "2.0",
          id: 101,
          method: "tools/call",
          params: { name: "cancelled-ids" },
        }),
      ),
    ).toMatchObject({ id: 101, result: { ids: [] } });
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "sends process-group SIGKILL to surviving descendants after the launcher exits on SIGTERM",
    async () => {
      const core = makeCore({ killGraceMs: 250 });
      const { post, initialize } = harness(core, server());
      const { sessionId } = await initialize();
      const [launcherPid] = core.pids();
      const spawned = await post(sessionId, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "spawn-grandchild" },
      });
      const grandchildPid = Number(body(spawned).result.content[0].text);
      expect(alive(launcherPid!)).toBe(true);
      expect(alive(grandchildPid)).toBe(true);

      await core.handle({
        serverId: "exec",
        server: server(),
        owner: "thread-a",
        method: "DELETE",
        sessionId,
        body: "",
      });
      await until(() => !alive(launcherPid!));
      // Grandchild ignored SIGTERM and is cleaned up when the process-group SIGKILL grace timer fires.
      await until(() => !alive(grandchildPid));
      await until(() => core.retiringCount === 0);
    },
  );

  it("reconcile keeps sessions matching the new config while closing stale ones", async () => {
    const core = makeCore();
    const oldConfig = server({ VERSION: "1" });
    const newConfig = server({ VERSION: "2" });
    const oldSession = await harness(core, oldConfig, "t1", "local").initialize();
    const newSession = await harness(core, newConfig, "t2", "local").initialize();
    const [oldPid, newPid] = core.pids("local");

    const localId = McpServerId.make("local");
    core.reconcile({
      [localId]: { transport: "stdio", ...newConfig, enabled: true },
    } as ServerSettings["mcpServers"]);

    await until(() => !alive(oldPid!));
    expect(alive(newPid!)).toBe(true);
    expect(
      (
        await harness(core, oldConfig, "t1", "local").post(oldSession.sessionId, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        })
      ).status,
    ).toBe(404);
    const stillAlive = await harness(core, newConfig, "t2", "local").post(newSession.sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "survived" } },
    });
    expect(body(stillAlive)).toMatchObject({ id: 1, result: { content: [{ text: "survived" }] } });
  });

  it("answers server-initiated ping with {} and rejects explicit invalid request ids", async () => {
    const core = makeCore();
    const { post, initialize } = harness(core);
    const { sessionId } = await initialize();
    const pinged = await post(sessionId, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ping-client" },
    });
    expect(body(pinged)).toMatchObject({ id: 4, result: { pong: {}, error: null } });

    for (const badId of [null, {}, [], true]) {
      const invalid = await post(sessionId, {
        jsonrpc: "2.0",
        id: badId,
        method: "tools/list",
      });
      expect(body(invalid)).toMatchObject({ id: null, error: { code: -32600 } });
    }
    // Absent id is still a valid notification.
    expect(
      (await post(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" })).status,
    ).toBe(202);
  });

  it.effect(
    "routes bridge logs through the Effect logger without leaking stderr or spawn paths",
    () =>
      Effect.gen(function* () {
        const logs: Array<string> = [];
        const captureLogger = Logger.make(({ message }) => {
          logs.push(JSON.stringify(message));
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const bridge = yield* makeStdioMcpBridge({ killGraceMs: 200 });
            const missing = yield* bridge.handle({
              serverId: "missing",
              server: { command: "/nonexistent/secret-bin/mcp", args: ["--token=abc"], env: {} },
              owner: "t1",
              method: "POST",
              sessionId: undefined,
              body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
            });
            expect(missing.body).not.toContain("/nonexistent/secret-bin/mcp");
            expect(missing.body).not.toContain("--token=abc");
            expect(body(missing)).toMatchObject({ id: 0, error: { code: -32000 } });

            const init = yield* bridge.handle({
              serverId: "exec",
              server: server(),
              owner: "t1",
              method: "POST",
              sessionId: undefined,
              body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
            });
            yield* bridge.handle({
              serverId: "exec",
              server: server(),
              owner: "t1",
              method: "POST",
              sessionId: init.headers["mcp-session-id"],
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "crash" },
              }),
            });
          }),
        ).pipe(Effect.provide(Logger.layer([captureLogger])));

        yield* Effect.promise(() =>
          expect.poll(() => logs.length, { timeout: 2000, interval: 10 }).toBeGreaterThanOrEqual(2),
        );
        const joined = logs.join("\n");
        expect(joined).toContain("stdio MCP session closed");
        expect(joined).toContain("ENOENT");
        expect(joined).not.toContain("SECRET_TOKEN_DO_NOT_LOG");
        expect(joined).not.toContain("/nonexistent/secret-bin/mcp");
      }),
  );

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
