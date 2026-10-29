/**
 * Per-call audit of PeerForward / remote MCP tool calls.
 *
 * One ndjson line per forwarded call under userdata logs
 * (`peer-forward.ndjson`). Never records tool arguments (they may hold
 * secrets); only tool name, target environment id, thread id when present,
 * timestamp, result status, and duration.
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

export const PEER_FORWARD_AUDIT_FILENAME = "peer-forward.ndjson";

export interface PeerForwardAuditEntry {
  readonly ts: string;
  readonly tool: string;
  readonly environmentId: string;
  readonly threadId: string | null;
  readonly status: string;
  readonly durationMs: number;
}

/** Absolute path of the peer-forward audit file in a userdata logs directory. */
export const peerForwardAuditPath = (logsDir: string): string =>
  NodePath.join(logsDir, PEER_FORWARD_AUDIT_FILENAME);

/**
 * Serialize one audit entry. Allowlisted fields only — never spreads an
 * unknown object that might carry args or secrets.
 */
export const formatPeerForwardAuditLine = (entry: PeerForwardAuditEntry): string =>
  JSON.stringify({
    ts: entry.ts,
    tool: entry.tool,
    environmentId: entry.environmentId,
    threadId: entry.threadId,
    status: entry.status,
    durationMs: entry.durationMs,
  });

/** Append one audit line to `logsDir/peer-forward.ndjson`, creating the dir. */
export const appendPeerForwardAudit = async (
  logsDir: string,
  entry: PeerForwardAuditEntry,
): Promise<void> => {
  await NodeFS.mkdir(logsDir, { recursive: true });
  await NodeFS.appendFile(
    peerForwardAuditPath(logsDir),
    `${formatPeerForwardAuditLine(entry)}\n`,
    "utf8",
  );
};

/** Pull a thread id out of encoded forward params without retaining other keys. */
export const threadIdFromForwardParams = (params: unknown): string | null => {
  if (params === null || typeof params !== "object") return null;
  const value = (params as { readonly threadId?: unknown }).threadId;
  return typeof value === "string" && value.length > 0 ? value : null;
};
