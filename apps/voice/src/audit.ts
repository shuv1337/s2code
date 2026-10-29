/**
 * Client-side audit of every tool call the voice model makes.
 * Allowlisted fields only: tool, env, thread, ts, status. Never args/secrets.
 * Client log only. The hub peer-forward path is unchanged in this spike.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const VOICE_TOOL_AUDIT_FILENAME = "voice-tool.ndjson";

export interface VoiceToolAuditEntry {
  readonly ts: string;
  readonly tool: string;
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly status: string;
}

export const voiceToolAuditPath = (auditDir: string): string =>
  NodePath.join(auditDir, VOICE_TOOL_AUDIT_FILENAME);

/** Serialize one audit entry. Never spreads unknown objects. */
export const formatVoiceToolAuditLine = (entry: VoiceToolAuditEntry): string =>
  JSON.stringify({
    ts: entry.ts,
    tool: entry.tool,
    environmentId: entry.environmentId,
    threadId: entry.threadId,
    status: entry.status,
  });

export const appendVoiceToolAudit = async (
  auditDir: string,
  entry: VoiceToolAuditEntry,
): Promise<void> => {
  await NodeFSP.mkdir(auditDir, { recursive: true });
  await NodeFSP.appendFile(
    voiceToolAuditPath(auditDir),
    `${formatVoiceToolAuditLine(entry)}\n`,
    "utf8",
  );
};

/** Pull threadId from tool args without retaining other keys. */
export const threadIdFromToolArgs = (args: unknown): string | null => {
  if (args === null || typeof args !== "object") return null;
  const value = (args as { readonly threadId?: unknown }).threadId;
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Pull environmentId from tool args without retaining other keys. */
export const environmentIdFromToolArgs = (args: unknown): string | null => {
  if (args === null || typeof args !== "object") return null;
  const value = (args as { readonly environmentId?: unknown }).environmentId;
  return typeof value === "string" && value.length > 0 ? value : null;
};
