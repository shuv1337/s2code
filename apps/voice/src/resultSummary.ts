/**
 * Short tool results for the live model. Discovery tools become a few ids and
 * labels. Secret-shaped fields are redacted before anything is truncated.
 */

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 4_000;

const SECRET_KEY =
  /(?:^|_)(?:token|secret|password|authorization|credential)(?:$|_)|api[-_]?key|mcpToken|accessToken|refreshToken|bearer/i;

const DISCOVERY_TOOLS = new Set<string>([
  "t3_environment_read",
  "t3_environment_links",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_search",
  "t3_thread_read",
  "t3_worktree_list",
  "t3_worktree_status",
]);

export const redactText = (text: string): string =>
  text
    .replace(/bearer\s+[a-z0-9._~+/-]{8,}/giu, "Bearer [redacted]")
    .replace(/\bsk-[a-z0-9]{8,}\b/giu, "[redacted]");

export const boundText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
};

const redactValue = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return "…";
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => redactValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1);
  }
  return out;
};

export const toolPayload = (content: unknown): Record<string, unknown> | undefined => {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof (part as { text: unknown }).text === "string"
    ) {
      try {
        const parsed = JSON.parse((part as { text: string }).text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* tool text was not JSON */
      }
    }
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = redactValue(record[key]);
  }
  return out;
};

const rows = (
  value: unknown,
  keys: readonly string[],
  limit: number,
): { readonly items: Record<string, unknown>[]; readonly truncated: boolean } => {
  if (!Array.isArray(value)) return { items: [], truncated: false };
  return {
    items: value.slice(0, limit).map((item) => pick(item, keys)),
    truncated: value.length > limit,
  };
};

const withTruncation = (
  summary: Record<string, unknown>,
  truncated: boolean,
): Record<string, unknown> => (truncated ? { ...summary, truncated: true } : summary);

const clipField = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = redactText(value).trim();
  if (text.length === 0) return undefined;
  return boundText(text, max);
};

const discoverySummary = (
  tool: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  switch (tool) {
    case "t3_environment_links": {
      const links = rows(payload.links, ["environmentId", "label", "status"], 12);
      return withTruncation(
        {
          environmentId: payload.environmentId,
          links: links.items,
        },
        links.truncated,
      );
    }
    case "t3_environment_read":
      return pick(payload, ["environmentId", "label", "serverVersion", "platform"]);
    case "t3_project_list": {
      const projects = rows(payload.projects, ["id", "title"], 20);
      const count = Array.isArray(payload.projects) ? payload.projects.length : 0;
      return withTruncation({ count, projects: projects.items }, projects.truncated);
    }
    case "t3_project_read":
      return pick(payload, ["id", "title", "workspaceRoot"]);
    case "t3_thread_list": {
      const threads = rows(payload.threads, ["threadId", "title", "status"], 15);
      return withTruncation(
        {
          projectId: payload.projectId,
          total: payload.total,
          threads: threads.items,
        },
        threads.truncated,
      );
    }
    case "t3_thread_search": {
      const matches = rows(payload.matches, ["threadId", "projectId", "title", "snippet"], 8);
      return withTruncation(
        {
          matches: matches.items.map((match) => {
            const snippet = clipField(match.snippet, 160);
            return snippet === undefined ? match : { ...match, snippet };
          }),
        },
        matches.truncated,
      );
    }
    case "t3_thread_read": {
      const thread = asRecord(payload.thread);
      const items = rows(payload.items, ["type", "title", "text", "status"], 4);
      return withTruncation(
        {
          thread: thread ? pick(thread, ["threadId", "title", "status", "projectId"]) : undefined,
          items: items.items.map((item) => {
            const text = clipField(item.text, 240);
            return text === undefined ? item : { ...item, text };
          }),
        },
        items.truncated,
      );
    }
    case "t3_worktree_list": {
      const refs = rows(payload.refs, ["name", "current", "worktreePath"], 12);
      return withTruncation({ totalCount: payload.totalCount, refs: refs.items }, refs.truncated);
    }
    case "t3_worktree_status":
      return pick(payload, ["attached", "branch", "worktreePath"]);
    default:
      return undefined;
  }
};

export const summarizeToolResult = (input: {
  readonly tool: string;
  readonly content: unknown;
  readonly maxChars?: number;
  readonly ok?: boolean;
}): string => {
  const max = input.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  const payload = toolPayload(input.content);
  const summary =
    input.ok !== false && payload && DISCOVERY_TOOLS.has(input.tool)
      ? discoverySummary(input.tool, payload)
      : undefined;
  const value = summary ?? redactValue(input.content);
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return boundText(text, max);
};
