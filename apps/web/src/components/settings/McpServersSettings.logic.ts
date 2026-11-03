import {
  McpServerId,
  type McpServerConfig,
  type McpServerTestInput,
  type McpServerTestResult,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeMcpServerId = Schema.decodeResult(McpServerId);

/** A saved token arrives redacted; only a replacement or a clear changes it. */
export type McpServerTokenDraft =
  | { readonly kind: "saved" }
  | { readonly kind: "new"; readonly value: string }
  | { readonly kind: "cleared" };

export interface McpServerDraft {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly token: McpServerTokenDraft;
}

export type McpServerTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: McpServerId; readonly config: McpServerConfig };

export type McpServerDraftIssues = {
  readonly id?: string;
  readonly url?: string;
};

const isMcpServerTokenConfigured = (config: McpServerConfig) => config.bearerToken !== "";

export function newMcpServerDraft(): McpServerDraft {
  return { id: "", label: "", url: "", token: { kind: "cleared" } };
}

export function draftFromMcpServer(id: McpServerId, config: McpServerConfig): McpServerDraft {
  return {
    id,
    label: config.label ?? "",
    url: config.url,
    token: isMcpServerTokenConfigured(config) ? { kind: "saved" } : { kind: "cleared" },
  };
}

/** Typing replaces the saved token; emptying the field brings it back, so only Clear drops it. */
export function nextMcpServerToken(value: string, target: McpServerTarget): McpServerTokenDraft {
  if (value !== "") return { kind: "new", value };
  return target.mode === "edit" && isMcpServerTokenConfigured(target.config)
    ? { kind: "saved" }
    : { kind: "cleared" };
}

function validateId(
  raw: string,
  existingIds: ReadonlySet<string>,
  target: McpServerTarget,
): Result.Result<McpServerId, string> {
  if (target.mode === "edit") return Result.succeed(target.id);
  const id = raw.trim();
  if (id === "") return Result.fail("Enter a name.");
  if (id.startsWith("t3")) return Result.fail("Names starting with “t3” are reserved for T3 Code.");
  const decoded = decodeMcpServerId(id);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      "Use up to 24 lowercase letters, digits, and hyphens, starting with a letter.",
    );
  }
  if (existingIds.has(decoded.success)) return Result.fail("A server with this name exists.");
  return Result.succeed(decoded.success);
}

function validateUrl(raw: string): Result.Result<string, string> {
  const url = raw.trim();
  if (url === "") return Result.fail("Enter the server URL.");
  if (!/^https?:\/\/./i.test(url) || !URL.canParse(url)) {
    return Result.fail("Enter an http:// or https:// URL.");
  }
  return Result.succeed(url);
}

/** True when the URL moved away from the saved one, so saving drops the saved token. */
export function savedTokenDropped(draft: McpServerDraft, target: McpServerTarget): boolean {
  return (
    target.mode === "edit" && draft.token.kind === "saved" && draft.url.trim() !== target.config.url
  );
}

function tokenValue(draft: McpServerDraft, target: McpServerTarget): string {
  const { token } = draft;
  switch (token.kind) {
    case "saved":
      // Sending the redaction marker back keeps the stored token.
      return target.mode === "edit" && !savedTokenDropped(draft, target)
        ? target.config.bearerToken
        : "";
    case "new":
      return token.value.trim();
    case "cleared":
      return "";
  }
}

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function mcpServerFromDraft(
  draft: McpServerDraft,
  existingIds: ReadonlySet<string>,
  target: McpServerTarget,
): Result.Result<
  { readonly id: McpServerId; readonly config: McpServerConfig },
  McpServerDraftIssues
> {
  const id = validateId(draft.id, existingIds, target);
  const url = validateUrl(draft.url);
  if (Result.isFailure(id) || Result.isFailure(url)) {
    return Result.fail({
      ...(Result.isFailure(id) ? { id: id.failure } : {}),
      ...(Result.isFailure(url) ? { url: url.failure } : {}),
    });
  }
  const label = draft.label.trim();
  return Result.succeed({
    id: id.success,
    config: {
      ...(label ? { label } : {}),
      url: url.success,
      bearerToken: tokenValue(draft, target),
      enabled: target.mode === "edit" ? target.config.enabled : true,
    },
  });
}

/**
 * The test request for a draft, or null while its name or URL is invalid. A kept saved token
 * is omitted so the server uses its own copy.
 */
export function mcpServerTestInputFromDraft(
  draft: McpServerDraft,
  existingIds: ReadonlySet<string>,
  target: McpServerTarget,
): McpServerTestInput | null {
  const entry = mcpServerFromDraft(draft, existingIds, target);
  if (Result.isFailure(entry)) return null;
  const { id, config } = entry.success;
  return draft.token.kind === "saved" && !savedTokenDropped(draft, target)
    ? { id, url: config.url }
    : { id, url: config.url, bearerToken: config.bearerToken };
}

export function mcpServerHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url;
}

const TOOLS_SHOWN = 3;

export function describeMcpServerTest(result: McpServerTestResult): {
  readonly label: string;
  readonly ok: boolean;
} {
  switch (result._tag) {
    case "Connected": {
      const count = result.tools.length;
      const names = result.tools.slice(0, TOOLS_SHOWN).join(", ");
      const more = count > TOOLS_SHOWN ? ", …" : "";
      const tools =
        count === 0 ? "no tools" : `${count} ${count === 1 ? "tool" : "tools"}: ${names}${more}`;
      return {
        label: `Connected${result.serverName ? ` to ${result.serverName}` : ""} · ${tools}`,
        ok: true,
      };
    }
    case "Rejected":
      return {
        label:
          result.status === 401 || result.status === 403
            ? `Rejected (HTTP ${result.status}): check the token`
            : `Rejected (HTTP ${result.status})`,
        ok: false,
      };
    case "Unreachable":
      return { label: result.timedOut ? "Timed out" : "Unreachable", ok: false };
    case "Failed":
      return { label: result.message, ok: false };
  }
}
