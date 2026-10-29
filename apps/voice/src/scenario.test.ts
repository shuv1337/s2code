import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import type { VoiceConfig } from "./config.ts";
import type { McpCallResult } from "./mcpBridge.ts";
import { createMockMcpBridge } from "./mcpBridge.ts";
import { createToolBridge } from "./toolBridge.ts";

const text = (value: unknown): McpCallResult => ({
  ok: true,
  status: "ok",
  content: [{ type: "text", text: JSON.stringify(value) }],
});

it("steers hub and peer, then speaks when the waited thread settles", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-scenario-"));
  const spoken: string[] = [];
  const config: VoiceConfig = {
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpToken: "test-token-not-real",
    auditDir: root,
    mode: "text-dry-run",
    liveModel: "gpt-live-1",
    backendModel: "gpt-5.6-luna",
    environmentLabels: {},
    defaultEnvironmentId: null,
    openaiApiKey: null,
    liveWsUrl: "wss://api.openai.com/v1/live/sessions",
  };
  const waits = new Map<string, number>();
  const mcp = createMockMcpBridge(async (name, args) => {
    if (name === "t3_environment_links") {
      return text({
        environmentId: "env-shuvdev",
        label: "shuvdev",
        links: [{ environmentId: "env-shuvbot", label: "shuvbot", status: "reachable" }],
      });
    }
    if (name === "t3_thread_list") {
      const peer = args.environmentId === "env-shuvbot";
      return text({
        threads: peer
          ? [
              { threadId: "thread-shuvcode", title: "shuvcode" },
              { threadId: "thread-running", title: "build" },
            ]
          : [{ threadId: "thread-notes", title: "notes" }],
      });
    }
    if (name === "t3_thread_read") {
      return text({ thread: { title: "shuvcode" }, items: [{ text: "Tests passed." }] });
    }
    if (name === "t3_thread_send" || name === "t3_thread_launch") {
      return text({
        threadId: name === "t3_thread_launch" ? "thread-launched" : args.threadId,
        status: "running",
      });
    }
    if (name === "t3_thread_wait") {
      const id = String(args.threadId);
      const count = (waits.get(id) ?? 0) + 1;
      waits.set(id, count);
      return text(
        count === 1
          ? { threadId: id, status: "running", timedOut: true }
          : { threadId: id, status: "completed", timedOut: false, summary: "Tests passed." },
      );
    }
    if (name === "t3_thread_interrupt") return text({ status: "interrupt_requested" });
    if (name === "t3_pending_request" && args.action === "list") {
      return text({ requestIds: ["req-1"] });
    }
    if (name === "t3_pending_request" && args.action === "read") {
      return text({
        requestId: "req-1",
        questions: [{ id: "q1", options: [{ label: "Approve", value: "accept" }] }],
      });
    }
    if (name === "t3_pending_request" && args.action === "respond") {
      return text({ sequence: 1, answers: args.answers });
    }
    if (name === "t3_workflow_stop") return text({ stopped: true });
    return text({ name });
  });
  const bridge = createToolBridge({
    config,
    mcp,
    speak: (line) => {
      spoken.push(line);
    },
  });

  await bridge.handleFunctionCall({ name: "t3_environment_links", arguments: {} });
  await bridge.handleFunctionCall({ name: "t3_thread_list", arguments: {} });
  await bridge.handleFunctionCall({
    name: "t3_thread_list",
    arguments: { environmentId: "env-shuvbot" },
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_read",
    arguments: { environmentId: "env-shuvbot", threadId: "thread-shuvcode" },
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_send",
    arguments: {
      environmentId: "env-shuvbot",
      threadId: "thread-shuvcode",
      message: "Rerun the tests.",
    },
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_launch",
    arguments: { environmentId: "env-shuvdev", projectId: "project-s2", title: "Fix the build" },
  });
  await bridge.handleFunctionCall({
    name: "t3_thread_interrupt",
    arguments: { environmentId: "env-shuvbot", threadId: "thread-running" },
  });
  const respond = bridge.handleFunctionCall({
    name: "t3_pending_request",
    arguments: {
      action: "respond",
      environmentId: "env-shuvbot",
      threadId: "thread-approval",
      requestId: "req-1",
      answers: { q1: "accept" },
    },
  });
  await respond;
  await bridge.drain();

  const declined = bridge.handleFunctionCall({
    name: "t3_workflow_stop",
    arguments: { environmentId: "env-shuvbot", threadId: "thread-running" },
  });
  bridge.hear("no");
  expect((await declined).status).toBe("rejected_confirmation");

  const names = mcp.calls.map((call) => call.name);
  expect(names).toContain("t3_environment_links");
  expect(names.filter((name) => name === "t3_thread_list")).toHaveLength(2);
  expect(names).toContain("t3_thread_send");
  expect(names).toContain("t3_thread_launch");
  expect(names).toContain("t3_thread_interrupt");
  expect(names).toContain("t3_pending_request");
  expect(names).not.toContain("t3_workflow_stop");
  expect(spoken.some((line) => line === "On shuvbot.")).toBe(true);
  expect(spoken.some((line) => line === "On shuvdev.")).toBe(true);
  expect(
    spoken.some((line) => line.startsWith("Done on shuvbot:") && line.includes("completed")),
  ).toBe(true);
  const audit = await NodeFSP.readFile(NodePath.join(root, "voice-tool.ndjson"), "utf8");
  expect(audit).toContain("t3_thread_send");
  expect(audit).not.toContain("Rerun the tests.");
  await NodeFSP.rm(root, { recursive: true, force: true });
});
