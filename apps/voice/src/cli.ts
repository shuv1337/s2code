#!/usr/bin/env node
/**
 * s2-voice CLI. Config from S2_VOICE_CONFIG / env. OpenAI key from env only
 * (inject via `op run`). Never prints tokens or keys.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { VoiceToolInputSchema } from "./allowlist.ts";
import { loadVoiceConfig } from "./config.ts";
import { cliFlag, runScriptedTextDryRun } from "./dryRun.ts";
import { connectLiveSession } from "./liveSession.ts";
import { createVoiceMcpBridge } from "./mcpBridge.ts";
import { createToolBridge } from "./toolBridge.ts";

let liveSend: ((event: Record<string, unknown>) => void) | undefined;
const speak = async (text: string) => {
  process.stderr.write(`[voice] ${text}\n`);
  liveSend?.({
    type: "session.commentary.append",
    delegation_id: null,
    content: text,
  });
};

const main = async () => {
  const args = process.argv.slice(2);
  const modeFlag = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : undefined;
  const useMockMcp = args.includes("--mock-mcp");

  const config = await loadVoiceConfig();
  const effectiveMode = modeFlag === "live" || modeFlag === "text-dry-run" ? modeFlag : config.mode;

  const auditDir = config.auditDir || NodePath.join(NodeOS.tmpdir(), "s2-voice-audit");
  await NodeFSP.mkdir(auditDir, { recursive: true });

  const resolved = {
    ...config,
    auditDir,
    mode: effectiveMode,
  };

  const mcp = createVoiceMcpBridge({
    mcpUrl: resolved.mcpUrl,
    mcpToken: resolved.mcpToken,
    useMockMcp,
  });

  let toolSchemas: Record<string, VoiceToolInputSchema> | undefined;
  try {
    const listed = await mcp.listTools();
    const schemas: Record<string, VoiceToolInputSchema> = {};
    for (const tool of listed) {
      if (tool.inputSchema) schemas[tool.name] = tool.inputSchema;
    }
    if (Object.keys(schemas).length > 0) toolSchemas = schemas;
  } catch (err) {
    const message = err instanceof Error ? err.message : "tools_list_failed";
    process.stderr.write(
      `[voice] tools/list failed (${message}); using allowlist argument metadata\n`,
    );
  }

  const bridge = createToolBridge({
    config: resolved,
    mcp,
    speak,
    ...(toolSchemas === undefined ? {} : { toolSchemas }),
  });

  if (effectiveMode === "text-dry-run") {
    process.stderr.write("[voice] text-dry-run starting\n");
    const flaggedProject = cliFlag(args, "--project-id");
    const projectId = flaggedProject ?? (useMockMcp ? "project-dry-run" : undefined);
    const results = await runScriptedTextDryRun(
      bridge,
      projectId === undefined ? {} : { projectId },
    );
    const summary = results.map((r) => ({
      name: r.name,
      status: r.status,
      rejected: r.rejected,
    }));
    process.stdout.write(`${JSON.stringify({ ok: true, results: summary })}\n`);
    return;
  }

  if (!resolved.openaiApiKey) {
    process.stderr.write(
      "[voice] blocked: need OpenAI key via masked field (OPENAI_API_KEY / op run)\n",
    );
    process.exitCode = 2;
    return;
  }

  process.stderr.write("[voice] connecting GPT-Live session\n");
  const session = connectLiveSession(resolved, bridge, {
    onSpeakText: (t) => {
      process.stderr.write(`[transcript] ${t}`);
    },
    onUserText: (t) => bridge.hear(t),
  });
  liveSend = session.send;
  await session.waitOpen();
  process.stderr.write("[voice] session open. Speak into the Live client path.\n");

  const shutdown = () => {
    session.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

main().catch((err) => {
  const message = err instanceof Error ? err.message : "unknown_error";
  // Never dump env or tokens.
  process.stderr.write(`[voice] fatal: ${message}\n`);
  process.exitCode = 1;
});
