#!/usr/bin/env node
/**
 * s2-voice CLI. Config from S2_VOICE_CONFIG / env. OpenAI key from env only
 * (inject via `2password run`). Never prints tokens or keys.
 */
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { loadVoiceConfig } from "./config.ts";
import { connectLiveSession, runTextDryRun } from "./liveSession.ts";
import { createVoiceMcpBridge } from "./mcpBridge.ts";
import { createToolBridge } from "./toolBridge.ts";

const speak = async (text: string) => {
  // Spoken path will hook TTS / Live commentary later; for now log to stderr
  // without secrets (tool bridge never passes args here).
  process.stderr.write(`[voice] ${text}\n`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const modeFlag = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : undefined;
  const useMockMcp = args.includes("--mock-mcp");

  const config = await loadVoiceConfig();
  const effectiveMode = modeFlag === "live" || modeFlag === "text-dry-run" ? modeFlag : config.mode;

  const auditDir = config.auditDir || NodePath.join(NodeOS.tmpdir(), "s2-voice-audit");
  await NodeFS.mkdir(auditDir, { recursive: true });

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

  const bridge = createToolBridge({
    config: resolved,
    mcp,
    speak,
  });

  if (effectiveMode === "text-dry-run") {
    process.stderr.write("[voice] text-dry-run starting\n");
    const results = await runTextDryRun(bridge, [
      {
        name: "t3_environment_links",
        arguments: {},
        callId: "dry_links",
      },
      {
        name: "t3_project_delete",
        arguments: { projectId: "should-reject" },
        callId: "dry_delete",
      },
      {
        name: "t3_thread_list",
        arguments: {},
        callId: "dry_list",
      },
    ]);
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
      "[voice] blocked: need OpenAI key via masked field (OPENAI_API_KEY / 2password)\n",
    );
    process.exitCode = 2;
    return;
  }

  process.stderr.write("[voice] connecting GPT-Live session\n");
  const session = connectLiveSession(resolved, bridge, {
    onSpeakText: (t) => {
      process.stderr.write(`[transcript] ${t}`);
    },
  });
  await session.waitOpen();
  process.stderr.write("[voice] session open — speak into the Live client path\n");

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
