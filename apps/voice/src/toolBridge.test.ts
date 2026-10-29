import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { voiceToolAuditPath } from "./audit.ts";
import type { VoiceConfig } from "./config.ts";
import { buildSessionCreatePayload } from "./liveSession.ts";
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
  expect(buildSessionCreatePayload(baseConfig(root)).type).toBe("session.start");
  await NodeFSP.rm(root, { recursive: true, force: true });
});
