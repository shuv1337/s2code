import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { voiceToolAuditPath } from "./audit.ts";
import type { VoiceConfig } from "./config.ts";
import { buildSessionCreatePayload, handleLiveOutputItem } from "./liveSession.ts";
import { createMockMcpBridge } from "./mcpBridge.ts";
import { createToolBridge } from "./toolBridge.ts";

const baseConfig = (auditDir: string): VoiceConfig => ({
  mcpUrl: "http://127.0.0.1:9/mcp",
  mcpToken: "test-token-not-real",
  auditDir,
  mode: "text-dry-run",
  liveModel: "gpt-live-1",
  backendModel: "gpt-5.1",
  environmentLabels: {
    "env-hub": "shuvdev",
    "env-peer": "shuvbot",
  },
  defaultEnvironmentId: "env-hub",
  toolResultMaxChars: 4_000,
  openaiApiKey: null,
  liveWsUrl: "wss://example.invalid/v1/live",
});

it("tool bridge rejects destructive tools and never calls MCP", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const spoken: string[] = [];
  const mcp = createMockMcpBridge();
  const bridge = createToolBridge({
    config: baseConfig(root),
    mcp,
    speak: (t) => {
      spoken.push(t);
    },
  });

  const result = await bridge.handleFunctionCall({
    name: "t3_project_delete",
    arguments: { projectId: "p1", environmentId: "env-peer" },
    callId: "c1",
  });

  expect(result.rejected).toBe(true);
  expect(result.status).toBe("rejected_destructive");
  expect(mcp.calls).toHaveLength(0);
  expect(spoken.some((s) => s.toLowerCase().includes("blocked") || s.includes("cannot"))).toBe(
    true,
  );

  const audit = await NodeFSP.readFile(voiceToolAuditPath(root), "utf8");
  expect(audit).toContain("rejected_destructive");
  expect(audit).not.toContain("test-token");
  expect(audit).not.toContain("projectId");
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("announces env and forwards allowlisted side-effect calls", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const spoken: string[] = [];
  const mcp = createMockMcpBridge(async (name) => {
    if (name === "t3_thread_send") {
      return { ok: true, status: "ok", content: [{ type: "text", text: '{"ok":true}' }] };
    }
    return { ok: true, status: "ok", content: null };
  });
  const bridge = createToolBridge({
    config: baseConfig(root),
    mcp,
    speak: (t) => {
      spoken.push(t);
    },
  });

  const result = await bridge.handleFunctionCall({
    name: "t3_thread_send",
    arguments: {
      threadId: "thread:abc",
      environmentId: "env-peer",
      message: "hello from voice",
    },
  });

  expect(result.rejected).toBe(false);
  expect(result.status).toBe("ok");
  expect(spoken[0]).toBe("On shuvbot.");
  expect(mcp.calls[0]!.name).toBe("t3_thread_send");
  await bridge.drain();
  expect(mcp.calls.map((call) => call.name)).toContain("t3_thread_wait");
  // Args go to MCP but must not appear in audit.
  const audit = await NodeFSP.readFile(voiceToolAuditPath(root), "utf8");
  expect(audit).toContain('"tool":"t3_thread_send"');
  expect(audit).toContain("thread:abc");
  expect(audit).not.toContain("hello from voice");
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("launch fires then waits and speaks a short summary", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const spoken: string[] = [];
  const mcp = createMockMcpBridge(async (name) => {
    if (name === "t3_thread_launch") {
      return {
        ok: true,
        status: "ok",
        content: [{ type: "text", text: JSON.stringify({ threadId: "mcp:launch:1" }) }],
      };
    }
    if (name === "t3_thread_wait") {
      return {
        ok: true,
        status: "ok",
        content: [{ type: "text", text: JSON.stringify({ status: "completed" }) }],
      };
    }
    return { ok: false, status: "unexpected", content: null, isError: true };
  });
  const bridge = createToolBridge({
    config: baseConfig(root),
    mcp,
    speak: (t) => {
      spoken.push(t);
    },
  });

  const result = await bridge.handleFunctionCall({
    name: "t3_thread_launch",
    arguments: { environmentId: "env-peer", title: "smoke" },
  });

  expect(result.status).toBe("ok");
  expect(mcp.calls[0]!.name).toBe("t3_thread_launch");
  await bridge.drain();
  expect(mcp.calls.map((c) => c.name)).toEqual(["t3_thread_launch", "t3_thread_wait"]);
  expect(spoken[0]).toBe("On shuvbot.");
  expect(spoken.some((s) => s.startsWith("Done on shuvbot"))).toBe(true);
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("text dry-run path rejects delete and allows links via liveSession helper", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const mcp = createMockMcpBridge();
  const bridge = createToolBridge({
    config: baseConfig(root),
    mcp,
    speak: () => undefined,
  });
  const links = bridge.handleFunctionCall({
    name: "t3_environment_links",
    arguments: {},
  });
  const stopped = bridge.handleFunctionCall({
    name: "t3_workflow_stop",
    arguments: { workflowId: "w1", environmentId: "env-peer" },
  });
  bridge.hear("no");
  const results = [await links, await stopped];
  expect(results[0]!.rejected).toBe(false);
  expect(results[1]!.status).toBe("rejected_confirmation");
  expect(mcp.calls.map((c) => c.name)).toEqual(["t3_environment_links"]);
  expect(mcp.calls[0]?.args).toEqual({});
  const payload = buildSessionCreatePayload(baseConfig(root));
  expect(payload.type).toBe("session.start");
  const tools = payload.session.delegation.responses.tools;
  expect(tools.every((tool) => tool.parameters.additionalProperties === false)).toBe(true);
  const linksTool = tools.find((tool) => tool.name === "t3_environment_links");
  expect(linksTool?.parameters.properties).not.toHaveProperty("environmentId");
  const threadList = tools.find((tool) => tool.name === "t3_thread_list");
  expect(threadList?.parameters.required).toContain("projectId");
  const projectIdProp = threadList?.parameters.properties.projectId as { description?: string };
  expect(projectIdProp.description).toMatch(/not inside a thread/u);
  const stop = tools.find((tool) => tool.name === "t3_workflow_stop");
  expect(stop?.parameters.required).toEqual(["threadId", "subagentId"]);
  const handoff = tools.find((tool) => tool.name === "t3_worktree_handoff");
  expect(handoff?.parameters.properties).not.toHaveProperty("environmentId");
  expect(handoff?.parameters.required).toEqual(["branch"]);
  const threadRead = tools.find((tool) => tool.name === "t3_thread_read");
  expect(threadRead?.parameters.properties).not.toHaveProperty("runId");
  expect(threadRead?.parameters.properties).toHaveProperty("afterPosition");
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("rejects a second confirmation and ignores yes after the window", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  let fire: (() => void) | undefined;
  const mcp = createMockMcpBridge();
  const bridge = createToolBridge({
    config: baseConfig(root),
    mcp,
    speak: () => undefined,
    scheduleTimeout: (_ms, onFire) => {
      fire = onFire;
      return () => {
        fire = undefined;
      };
    },
  });
  const first = bridge.handleFunctionCall({
    name: "t3_workflow_stop",
    arguments: { environmentId: "env-peer", threadId: "thread-running" },
    callId: "call-stop",
  });
  const second = await bridge.handleFunctionCall({
    name: "t3_preview_close",
    arguments: { environmentId: "env-peer" },
  });
  expect(second.status).toBe("rejected_confirmation");
  fire?.();
  expect((await first).status).toBe("rejected_confirmation");
  bridge.hear("yes approve");
  expect(mcp.calls.map((call) => call.name)).not.toContain("t3_workflow_stop");
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("stamps clientRequestId from the voice call id and keeps captured args", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const mcp = createMockMcpBridge();
  const bridge = createToolBridge({
    config: baseConfig(root),
    mcp,
    speak: () => undefined,
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_send",
    callId: "call-9",
    arguments: {
      environmentId: "env-peer",
      threadId: "thread-shuvcode",
      message: "Rerun the tests.",
    },
  });
  expect(mcp.calls[0]?.args).toMatchObject({
    clientRequestId: "call-9",
    message: "Rerun the tests.",
    threadId: "thread-shuvcode",
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_send",
    callId: "call-live",
    arguments: {
      environmentId: "env-peer",
      threadId: "thread-shuvcode",
      message: "Again.",
      clientRequestId: "model-made-this-up",
    },
  });
  const sends = mcp.calls.filter((call) => call.name === "t3_thread_send");
  expect(sends[1]?.args.clientRequestId).toBe("call-live");
  await bridge.handleFunctionCall({
    name: "t3_pending_request",
    callId: "call-pending",
    arguments: {
      action: "respond",
      environmentId: "env-peer",
      requestId: "req-1",
      answers: { q1: "accept" },
      clientRequestId: "model-made-this-up",
    },
  });
  const pending = mcp.calls.find((call) => call.name === "t3_pending_request");
  expect(pending?.args).not.toHaveProperty("clientRequestId");
  expect(pending?.args).toMatchObject({ action: "respond", requestId: "req-1" });
  const skipped = await handleLiveOutputItem(
    { type: "function_call", name: "t3_thread_send", arguments: "{}" },
    bridge,
    () => undefined,
  );
  expect(skipped).toBe(false);
  await bridge.drain();
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("does not send environmentId on t3_environment_links", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const mcp = createMockMcpBridge();
  const bridge = createToolBridge({
    config: { ...baseConfig(root), defaultEnvironmentId: "env-peer" },
    mcp,
    speak: () => undefined,
    toolSchemas: {
      t3_environment_links: { properties: {}, additionalProperties: false },
    },
  });

  await bridge.handleFunctionCall({
    name: "t3_environment_links",
    callId: "dry_links",
    arguments: { environmentId: "env-peer" },
  });

  expect(mcp.calls).toEqual([{ name: "t3_environment_links", args: {} }]);
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("keeps discovery on the hub when the default environment is a peer", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const mcp = createMockMcpBridge(async () => ({
    ok: true,
    status: "ok",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          environmentId: "env-hub",
          label: "shuvdev",
          links: [{ environmentId: "env-peer", label: "shuvbot", status: "reachable" }],
        }),
      },
    ],
  }));
  const bridge = createToolBridge({
    config: { ...baseConfig(root), defaultEnvironmentId: "env-peer" },
    mcp,
    speak: () => undefined,
  });

  await bridge.handleFunctionCall({ name: "t3_environment_read", arguments: {} });
  await bridge.handleFunctionCall({
    name: "t3_environment_read",
    arguments: { environmentId: "env-peer" },
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_send",
    arguments: { threadId: "thread-1", message: "hi" },
  });

  expect(mcp.calls[0]?.args).toEqual({});
  expect(mcp.calls[1]?.args).toEqual({ environmentId: "env-peer" });
  expect(mcp.calls[2]?.args).toMatchObject({
    environmentId: "env-peer",
    threadId: "thread-1",
    message: "hi",
  });
  await bridge.drain();
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("follows a peer default from launch into read and wait", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const mcp = createMockMcpBridge(async (name) => ({
    ok: true,
    status: "ok",
    content: [
      {
        type: "text",
        text: JSON.stringify(
          name === "t3_thread_launch" ? { threadId: "thread-launched" } : { ok: true },
        ),
      },
    ],
  }));
  const bridge = createToolBridge({
    config: { ...baseConfig(root), defaultEnvironmentId: "env-peer" },
    mcp,
    speak: () => undefined,
  });

  const launched = await bridge.handleFunctionCall({
    name: "t3_thread_launch",
    arguments: { title: "smoke", projectId: "project-s2" },
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_read",
    arguments: { threadId: "thread-launched" },
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_wait",
    arguments: { threadId: "thread-launched" },
  });
  await bridge.handleFunctionCall({ name: "t3_worktree_list", arguments: {} });

  expect(launched.output).toContain('"environmentId":"env-peer"');
  expect(mcp.calls.find((call) => call.name === "t3_thread_launch")?.args.environmentId).toBe(
    "env-peer",
  );
  expect(mcp.calls.find((call) => call.name === "t3_thread_read")?.args).toEqual({
    environmentId: "env-peer",
    threadId: "thread-launched",
  });
  expect(mcp.calls.find((call) => call.name === "t3_thread_wait")?.args.environmentId).toBe(
    "env-peer",
  );
  expect(mcp.calls.find((call) => call.name === "t3_worktree_list")?.args).toEqual({
    environmentId: "env-peer",
  });
  await bridge.drain();
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("summarizes discovery results and redacts secrets before the model sees them", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-bridge-"));
  const secret = "sekret-token-value";
  const blob = "x".repeat(5_000);
  const mcp = createMockMcpBridge(async (name) => {
    if (name === "t3_environment_read") {
      return {
        ok: true,
        status: "ok",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              environmentId: "env-hub",
              label: "shuvdev",
              serverVersion: "1",
              platform: "linux",
              mcpToken: secret,
              preferences: { customInstructions: blob },
            }),
          },
        ],
      };
    }
    return {
      ok: true,
      status: "ok",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            token: secret,
            nested: JSON.stringify({ clientSecret: secret, authToken: secret }),
            leak: `https://example.test/a?token=${secret}#token=${secret} sk-proj-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwxyz`,
            note: blob,
          }),
        },
      ],
    };
  });
  const bridge = createToolBridge({
    config: { ...baseConfig(root), toolResultMaxChars: 1_000 },
    mcp,
    speak: () => undefined,
  });

  const read = await bridge.handleFunctionCall({ name: "t3_environment_read", arguments: {} });
  expect(read.output).toContain("shuvdev");
  expect(read.output).not.toContain(secret);
  expect(read.output).not.toContain(blob);
  expect(read.output.length).toBeLessThan(400);

  const send = await bridge.handleFunctionCall({
    name: "t3_thread_send",
    arguments: { threadId: "thread-1", message: "hello", environmentId: "env-hub" },
  });
  expect(send.output).not.toContain(secret);
  expect(send.output).toContain("[redacted]");
  expect(send.output).not.toContain("sk-proj-abcdefghijklmnop");
  expect(send.output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  expect(send.output.indexOf("[redacted]")).toBeLessThan(send.output.indexOf("xxxx"));
  expect(send.output.length).toBeGreaterThan(400);
  expect(send.output.length).toBeLessThanOrEqual(1_200);
  await bridge.drain();
  await NodeFSP.rm(root, { recursive: true, force: true });
});
