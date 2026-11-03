import {
  McpServerConfig,
  McpServerId,
  type McpServerTestInput,
  type McpServerTestResult,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What the server sends in place of a saved token, and accepts back as "keep it". */
export const MCP_SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

const decodeId = Schema.decodeUnknownOption(McpServerId);
const decodeConfig = Schema.decodeUnknownOption(McpServerConfig);

export interface McpServerDraft {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** A newly typed token. Empty keeps whatever is saved unless `clearToken` is set. */
  readonly token: string;
  readonly clearToken: boolean;
  readonly enabled: boolean;
}

export function mcpServerDraft(id: string, saved: McpServerConfig | undefined): McpServerDraft {
  return {
    id,
    label: saved?.label ?? "",
    url: saved?.url ?? "",
    token: "",
    clearToken: false,
    enabled: saved?.enabled ?? true,
  };
}

export function mcpServerHasToken(config: McpServerConfig | undefined): boolean {
  return config !== undefined && config.bearerToken !== "";
}

export function mcpServerHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? url;
}

export function sortedMcpServers(servers: Readonly<Record<string, McpServerConfig>>) {
  return Object.entries(servers)
    .map(([id, config]) => ({ id, config }))
    .sort((left, right) =>
      (left.config.label ?? left.id).localeCompare(right.config.label ?? right.id),
    );
}

type Parsed<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

export function parseMcpServerId(
  id: string,
  existing: Readonly<Record<string, McpServerConfig>>,
  isNew: boolean,
): Parsed<McpServerId> {
  const trimmed = id.trim();
  if (!trimmed) return { ok: false, error: "Enter a name." };
  if (trimmed.startsWith("t3")) return { ok: false, error: "Names starting with t3 are reserved." };
  const decoded = decodeId(trimmed);
  if (Option.isNone(decoded))
    return {
      ok: false,
      error: "Use up to 24 lowercase letters, digits, or hyphens, starting with a letter.",
    };
  if (isNew && trimmed in existing)
    return { ok: false, error: `A server named ${trimmed} already exists.` };
  return { ok: true, value: decoded.value };
}

/** A saved token never follows the server to a new URL; saving there drops it. */
export function mcpSavedTokenKept(
  draft: McpServerDraft,
  saved: McpServerConfig | undefined,
): boolean {
  return mcpServerHasToken(saved) && !draft.clearToken && draft.url.trim() === saved?.url;
}

function bearerToken(draft: McpServerDraft, saved: McpServerConfig | undefined): string {
  const typed = draft.token.trim();
  if (typed) return typed;
  return mcpSavedTokenKept(draft, saved) ? MCP_SECRET_REDACTED : "";
}

export function parseMcpServerDraft(
  draft: McpServerDraft,
  existing: Readonly<Record<string, McpServerConfig>>,
  isNew: boolean,
): Parsed<{ readonly id: McpServerId; readonly config: McpServerConfig }> {
  const id = parseMcpServerId(draft.id, existing, isNew);
  if (!id.ok) return id;
  const saved = isNew ? undefined : existing[id.value];
  const label = draft.label.trim();
  const config = decodeConfig({
    ...(label ? { label } : {}),
    url: draft.url.trim(),
    bearerToken: bearerToken(draft, saved),
    enabled: draft.enabled,
  });
  if (Option.isNone(config))
    return { ok: false, error: "Enter a URL starting with http:// or https://." };
  return { ok: true, value: { id: id.value, config: config.value } };
}

/** Omitting the token tells the server to test with the saved one. */
export function mcpServerTestInput(
  draft: McpServerDraft,
  existing: Readonly<Record<string, McpServerConfig>>,
  isNew: boolean,
): Parsed<McpServerTestInput> {
  const parsed = parseMcpServerDraft(draft, existing, isNew);
  if (!parsed.ok) return parsed;
  const { id, config } = parsed.value;
  return {
    ok: true,
    value:
      config.bearerToken === MCP_SECRET_REDACTED
        ? { id, url: config.url }
        : { id, url: config.url, bearerToken: config.bearerToken },
  };
}

export function upsertMcpServerPatch(id: string, config: McpServerConfig) {
  return { mcpServers: { [id]: config } } as ServerSettingsPatch;
}

export function removeMcpServerPatch(id: string) {
  return { mcpServers: { [id]: null } } as ServerSettingsPatch;
}

export function describeMcpServerTest(result: McpServerTestResult): {
  readonly tone: "default" | "danger";
  readonly message: string;
} {
  switch (result._tag) {
    case "Connected": {
      const name = result.serverName ?? "the server";
      const count = result.tools.length;
      if (count === 0)
        return { tone: "default", message: `Connected to ${name}. No tools listed.` };
      const shown = result.tools.slice(0, 8).join(", ");
      const more = count > 8 ? `, and ${count - 8} more` : "";
      return {
        tone: "default",
        message: `Connected to ${name}. ${count === 1 ? "1 tool" : `${count} tools`}: ${shown}${more}.`,
      };
    }
    case "Rejected":
      return {
        tone: "danger",
        message:
          result.status === 401 || result.status === 403
            ? `The server rejected the token (HTTP ${result.status}).`
            : `The server responded with HTTP ${result.status}.`,
      };
    case "Unreachable":
      return {
        tone: "danger",
        message: result.timedOut
          ? "The server did not respond in time."
          : "Could not reach the server.",
      };
    case "Failed":
      return { tone: "danger", message: result.message };
  }
}
