import type { McpServerConfig, McpServerId, McpServerTestInput } from "@t3tools/contracts";

/** What the server sends in place of a saved token, and accepts back as "keep it". */
export const MCP_TOKEN_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

export interface McpServerTokenEdit {
  readonly saved: McpServerConfig | undefined;
  readonly url: string;
  /** Blank keeps the saved token. */
  readonly typed: string;
  readonly cleared: boolean;
}

/** The server drops a saved token whose URL changed, so the form never offers to keep it there. */
export function mcpSavedTokenKept({ saved, url, cleared }: McpServerTokenEdit): boolean {
  return saved !== undefined && saved.bearerToken !== "" && !cleared && url.trim() === saved.url;
}

/** Typed text replaces the token, the redaction marker keeps the saved one, and empty removes it. */
export function mcpServerTokenToSave(edit: McpServerTokenEdit): string {
  const typed = edit.typed.trim();
  if (typed) return typed;
  return mcpSavedTokenKept(edit) ? MCP_TOKEN_REDACTED : "";
}

/** Omitting the token tells the server to test with its saved copy. */
export function mcpServerTestInput(
  id: McpServerId,
  url: string,
  edit: McpServerTokenEdit,
): McpServerTestInput {
  const bearerToken = mcpServerTokenToSave(edit);
  return bearerToken === MCP_TOKEN_REDACTED ? { id, url } : { id, url, bearerToken };
}
