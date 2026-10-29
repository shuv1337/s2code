import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import type { VoiceConfig } from "./config.ts";
import { cliFlag, projectIdFromListOutput, runScriptedTextDryRun } from "./dryRun.ts";
import type { McpCallResult } from "./mcpBridge.ts";
import { createMockMcpBridge } from "./mcpBridge.ts";
import { createToolBridge } from "./toolBridge.ts";

const text = (value: unknown): McpCallResult => ({
  ok: true,
  status: "ok",
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const config = (auditDir: string, defaultEnvironmentId: string | null): VoiceConfig => ({
  mcpUrl: "http://127.0.0.1:9/mcp",
  mcpToken: "test-token-not-real",
  auditDir,
  mode: "text-dry-run",
  liveModel: "gpt-live-1",
  backendModel: "gpt-5.6-luna",
  environmentLabels: { "env-hub": "shuvdev", "env-peer": "shuvbot" },
  defaultEnvironmentId,
  toolResultMaxChars: 4_000,
  openaiApiKey: null,
  liveWsUrl: "wss://example.invalid/v1/live",
});

it("dry-run passes projectId and does not inject a peer default into discovery", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-dry-"));
  const mcp = createMockMcpBridge(async (name) => {
    if (name === "t3_project_list") {
      return text({ projects: [{ id: "project-s2", title: "s2code" }] });
    }
    if (name === "t3_environment_links") {
      return text({
        environmentId: "env-hub",
        links: [{ environmentId: "env-peer", label: "shuvbot", status: "reachable" }],
      });
    }
    return text({ projectId: "project-s2", threads: [], total: 0 });
  });
  const bridge = createToolBridge({
    config: config(root, "env-peer"),
    mcp,
    speak: () => undefined,
  });

  const results = await runScriptedTextDryRun(bridge, {});
  const links = mcp.calls.find((call) => call.name === "t3_environment_links");
  const list = mcp.calls.find((call) => call.name === "t3_thread_list");
  expect(links?.args).toEqual({});
  expect(list?.args).toEqual({ projectId: "project-s2" });
  expect(list?.args).not.toHaveProperty("environmentId");
  expect(results.find((result) => result.name === "t3_thread_list")?.status).toBe("ok");
  expect(results.find((result) => result.name === "t3_project_delete")?.rejected).toBe(true);

  mcp.calls.length = 0;
  const flagged = await runScriptedTextDryRun(bridge, { projectId: "project-flagged" });
  expect(mcp.calls.map((call) => call.name)).not.toContain("t3_project_list");
  expect(mcp.calls.find((call) => call.name === "t3_thread_list")?.args).toEqual({
    projectId: "project-flagged",
  });
  expect(flagged.find((result) => result.name === "t3_thread_list")?.rejected).toBe(false);
  await NodeFSP.rm(root, { recursive: true, force: true });
});

it("dry-run skips thread list when no project is available", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-dry-"));
  const mcp = createMockMcpBridge(async () => text({ projects: [] }));
  const bridge = createToolBridge({
    config: config(root, null),
    mcp,
    speak: () => undefined,
  });
  const results = await runScriptedTextDryRun(bridge, {});
  expect(mcp.calls.map((call) => call.name)).not.toContain("t3_thread_list");
  expect(results.find((result) => result.name === "t3_thread_list")?.status).toBe(
    "skipped_no_project",
  );
  expect(projectIdFromListOutput('{"projects":[{"id":"project-a"}]}')).toBe("project-a");
  expect(projectIdFromListOutput("not-json")).toBeUndefined();
  expect(cliFlag(["--mode", "text-dry-run", "--project-id", "project-a"], "--project-id")).toBe(
    "project-a",
  );
  expect(cliFlag(["--project-id", "--mode"], "--project-id")).toBeUndefined();
  await NodeFSP.rm(root, { recursive: true, force: true });
});
