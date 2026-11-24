import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";
import {
  isHttpMcpServer,
  McpServerConfig,
  type McpServerEntry,
  McpServerId,
  type McpServerTestInput,
  type McpServerTestResult,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  mcpSavedTokenKept as sharedSavedTokenKept,
  mcpServerTestInput as sharedTestInput,
  mcpServerTokenToSave,
  type McpServerTokenEdit,
} from "@t3tools/client-runtime/mcp-server-token";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

/** `existing` holds every saved entry, any transport, so a new name can't replace one. */
export function parseMcpServerId(
  id: string,
  existing: Readonly<Record<string, McpServerEntry>>,
  isNew: boolean,
): Parsed<McpServerId> {
  const trimmed = id.trim();
  if (!trimmed) return { ok: false, error: m(msg("Enter a name.")) };
  if (trimmed.startsWith("t3"))
    return { ok: false, error: m(msg("Names starting with t3 are reserved.")) };
  const decoded = decodeId(trimmed);
  if (Option.isNone(decoded))
    return {
      ok: false,
      error: m(msg("Use up to 24 lowercase letters, digits, or hyphens, starting with a letter.")),
    };
  if (isNew && trimmed in existing)
    return { ok: false, error: m(msg("A server named {name} already exists.", { name: trimmed })) };
  return { ok: true, value: decoded.value };
}

function tokenEdit(draft: McpServerDraft, saved: McpServerConfig | undefined): McpServerTokenEdit {
  return { saved, url: draft.url, typed: draft.token, cleared: draft.clearToken };
}

export function mcpSavedTokenKept(
  draft: McpServerDraft,
  saved: McpServerConfig | undefined,
): boolean {
  return sharedSavedTokenKept(tokenEdit(draft, saved));
}

const savedHttpServer = (
  existing: Readonly<Record<string, McpServerEntry>>,
  id: string,
): McpServerConfig | undefined => {
  const entry = Object.hasOwn(existing, id) ? existing[id] : undefined;
  return entry !== undefined && isHttpMcpServer(entry) ? entry : undefined;
};

export function parseMcpServerDraft(
  draft: McpServerDraft,
  existing: Readonly<Record<string, McpServerEntry>>,
  isNew: boolean,
): Parsed<{ readonly id: McpServerId; readonly config: McpServerConfig }> {
  const id = parseMcpServerId(draft.id, existing, isNew);
  if (!id.ok) return id;
  const saved = isNew ? undefined : savedHttpServer(existing, id.value);
  const label = draft.label.trim();
  const config = decodeConfig({
    ...(label ? { label } : {}),
    url: draft.url.trim(),
    bearerToken: mcpServerTokenToSave(tokenEdit(draft, saved)),
    enabled: draft.enabled,
    ...(saved?.projectIds === undefined ? {} : { projectIds: saved.projectIds }),
    ...(saved?.excludeSubagents === undefined ? {} : { excludeSubagents: saved.excludeSubagents }),
  });
  if (Option.isNone(config))
    return { ok: false, error: m(msg("Enter a URL starting with http:// or https://.")) };
  return { ok: true, value: { id: id.value, config: config.value } };
}

export function mcpServerTestInput(
  draft: McpServerDraft,
  existing: Readonly<Record<string, McpServerEntry>>,
  isNew: boolean,
): Parsed<McpServerTestInput> {
  const parsed = parseMcpServerDraft(draft, existing, isNew);
  if (!parsed.ok) return parsed;
  const { id, config } = parsed.value;
  const saved = isNew ? undefined : savedHttpServer(existing, id);
  return { ok: true, value: sharedTestInput(id, config.url, tokenEdit(draft, saved)) };
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
      const name = result.serverName ?? m(msg("the server"));
      const count = result.tools.length;
      if (count === 0)
        return {
          tone: "default",
          message: m(msg("Connected to {name}. No tools listed.", { name })),
        };
      const shown = result.tools.slice(0, 8).join(", ");
      const more = count > 8 ? m(msg(", and {count} more", { count: count - 8 })) : "";
      return {
        tone: "default",
        message: m(
          msg(
            "Connected to {name}. {count, plural, one {{count} tool} other {{count} tools}}: {shown}{more}.",
            { name, count, shown, more },
          ),
        ),
      };
    }
    case "Rejected":
      return {
        tone: "danger",
        message:
          result.status === 401 || result.status === 403
            ? m(msg("The server rejected the token (HTTP {status}).", { status: result.status }))
            : m(msg("The server responded with HTTP {status}.", { status: result.status })),
      };
    case "Unreachable":
      return {
        tone: "danger",
        message: result.timedOut
          ? m(msg("The server did not respond in time."))
          : m(msg("Could not reach the server.")),
      };
    case "Failed":
      return { tone: "danger", message: result.message };
  }
}
