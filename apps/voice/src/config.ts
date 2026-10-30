/**
 * Load voice orchestrator config from env and/or an external JSON file.
 * Hostnames, tokens, and API keys must never be committed to the repo.
 */
import * as NodeFSP from "node:fs/promises";

import { DEFAULT_TOOL_RESULT_MAX_CHARS } from "@t3tools/shared/voice/resultSummary";

export type VoiceMode = "live" | "text-dry-run";

export interface VoiceConfig {
  readonly mcpUrl: string;
  readonly mcpToken: string;
  readonly auditDir: string;
  readonly mode: VoiceMode;
  readonly liveModel: string;
  readonly backendModel: string;
  readonly environmentLabels: Readonly<Record<string, string>>;
  readonly defaultEnvironmentId: string | null;
  /** Max chars of a tool result given to the model. Discovery tools are summarized first. */
  readonly toolResultMaxChars: number;
  readonly openaiApiKey: string | null;
  readonly liveWsUrl: string;
}

const DEFAULT_LIVE_WS = "wss://api.openai.com/v1/live/sessions";

export interface RawVoiceConfigFile {
  readonly mcpUrl?: string;
  readonly mcpToken?: string;
  readonly auditDir?: string;
  readonly mode?: string;
  readonly liveModel?: string;
  readonly backendModel?: string;
  readonly environmentLabels?: Record<string, string>;
  readonly defaultEnvironmentId?: string;
  readonly toolResultMaxChars?: number;
  readonly liveWsUrl?: string;
}

const parseToolResultMaxChars = (value: unknown): number => {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_TOOL_RESULT_MAX_CHARS;
  return Math.min(100_000, Math.max(200, Math.floor(parsed)));
};

const asMode = (value: string | undefined, fallback: VoiceMode): VoiceMode => {
  if (value === "live" || value === "text-dry-run") return value;
  return fallback;
};

export const loadVoiceConfig = async (options?: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<VoiceConfig> => {
  const env = options?.env ?? process.env;
  const path = options?.configPath ?? env.S2_VOICE_CONFIG;
  let file: RawVoiceConfigFile = {};
  if (path) {
    const text = await NodeFSP.readFile(path, "utf8");
    file = JSON.parse(text) as RawVoiceConfigFile;
  }

  const mode = asMode(env.S2_VOICE_MODE ?? file.mode, "text-dry-run");
  const openaiApiKey = env.OPENAI_API_KEY?.trim() || null;

  return {
    mcpUrl: (env.S2_VOICE_MCP_URL ?? file.mcpUrl ?? "").trim(),
    mcpToken: (env.S2_VOICE_MCP_TOKEN ?? file.mcpToken ?? "").trim(),
    auditDir: (env.S2_VOICE_AUDIT_DIR ?? file.auditDir ?? "").trim(),
    mode,
    liveModel: (env.S2_VOICE_LIVE_MODEL ?? file.liveModel ?? "gpt-live-1").trim(),
    backendModel: (env.S2_VOICE_BACKEND_MODEL ?? file.backendModel ?? "gpt-5.6-luna").trim(),
    environmentLabels: file.environmentLabels ?? {},
    defaultEnvironmentId: file.defaultEnvironmentId?.trim() || null,
    toolResultMaxChars: parseToolResultMaxChars(
      env.S2_VOICE_TOOL_RESULT_MAX_CHARS ?? file.toolResultMaxChars,
    ),
    openaiApiKey,
    liveWsUrl: (env.S2_VOICE_LIVE_WS_URL ?? file.liveWsUrl ?? DEFAULT_LIVE_WS).trim(),
  };
};

export const labelForEnvironment = (
  config: VoiceConfig,
  environmentId: string | null,
): string | null => {
  if (!environmentId) return null;
  return config.environmentLabels[environmentId] ?? null;
};
