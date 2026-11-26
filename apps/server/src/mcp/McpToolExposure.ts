import type { McpToolExposureMode } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const TOOL_SEARCH = "tool_search";

/** What a deferring client lists before it searches. Pi's extension declares the same three. */
const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  TOOL_SEARCH,
]);

/**
 * Curated eager core set for clients with an eager MCP schema cap (e.g. agy ~45 KB)
 * that only register tools loaded via `notifications/tools/list_changed` on the next turn.
 */
export const COMPACT_EAGER_TOOLS: ReadonlySet<string> = new Set([
  // Orchestration, tasks, scheduling, and secrets
  "orchestrator_capabilities",
  "orchestrator_usage_limits",
  "delegate_task",
  "create_threads",
  "task_status",
  "task_cancel",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "run_scheduled_task_now",
  "request_secret",
  "t3_thread_launch",
  // Threads
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_thread_search",
  "t3_thread_configure",
  "t3_thread_transfer",
  "t3_thread_organize",
  "t3_pending_request",
  "t3_queue",
  "t3_submit_output",
  // Pull requests and CI
  "pull_request_read",
  "pull_request_list",
  "pull_request_create",
  "pull_request_update",
  "pull_request_respond",
  "pull_request_review",
  "pull_request_merge",
  "link_pull_request",
  "link_pull_requests",
  "unlink_pull_request",
  "unlink_pull_requests",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "ci_logs",
  "ci_rerun",
  // Issues
  "list_issues",
  "read_issue",
  "create_issue",
  "comment_on_issue",
  "set_issue_state",
  "link_issue",
  "unlink_issue",
  "list_thread_issues",
  // User output, HTML, and discovery
  "send_to_user",
  "html_preview",
  "html_render",
  TOOL_SEARCH,
]);

export const parseExposureMode = (
  value: string | ReadonlyArray<string> | undefined,
): McpToolExposureMode | undefined =>
  value === "deferred" || value === "compact" ? value : undefined;

/**
 * Dynamic tool budget for `compact` sessions: <= 38 KB static eager + 3.5 KB dynamic
 * stays safely below agy's ~45 KB eager MCP schema cap even alongside shared servers.
 */
export const COMPACT_DYNAMIC_MAX_BYTES = 3_500;

const MAX_RESULTS = 10;
// Sessions that ended are never reported here, so keep only the newest.
const MAX_SESSIONS = 256;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly bytes?: number;
}

export interface SearchResultTool {
  readonly name: string;
  readonly description: string;
}

export class McpToolExposure extends Context.Service<
  McpToolExposure,
  {
    /** Finds tools for the query and lists them to the session from now on. */
    readonly search: (
      providerSessionId: string,
      query: string,
      mode: McpToolExposureMode | undefined,
    ) => Effect.Effect<ReadonlyArray<SearchResultTool>>;
    readonly isListed: (
      providerSessionId: string,
      tool: string,
      mode: McpToolExposureMode,
    ) => boolean;
  }
>()("t3/mcp/McpToolExposure") {}

const score = (tool: ListedTool, terms: ReadonlyArray<string>) => {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term === name) total += 100;
    else if (name.includes(term)) total += 3;
    else if (description.includes(term)) total += 1;
  }
  return total;
};

const eagerToolsFor = (mode: McpToolExposureMode): ReadonlySet<string> =>
  mode === "compact" ? COMPACT_EAGER_TOOLS : DIRECT_TOOLS;

const sessionKey = (providerSessionId: string, mode: McpToolExposureMode): string =>
  `${mode}:${providerSessionId}`;

// Include +1 byte for the JSON array comma separator when appended to listed tools.
const entryBytes = (tool: ListedTool): number =>
  (tool.bytes ??
    Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description }), "utf8")) +
  1;

const selectMatches = (
  ranked: ReadonlyArray<ListedTool>,
  mode: McpToolExposureMode | undefined,
): ReadonlyArray<ListedTool> => {
  if (mode !== "compact") return ranked;
  const selected: Array<ListedTool> = [];
  let usedBytes = 0;
  for (const tool of ranked) {
    const bytes = entryBytes(tool);
    if (usedBytes + bytes <= COMPACT_DYNAMIC_MAX_BYTES) {
      selected.push(tool);
      usedBytes += bytes;
    }
  }
  return selected;
};

export const make = (
  tools: () => ReadonlyArray<ListedTool>,
  announceListChanged: () => Effect.Effect<void>,
) => {
  const loaded = new Map<string, Map<string, number>>();
  const load = (
    providerSessionId: string,
    selected: ReadonlyArray<ListedTool>,
    mode: McpToolExposureMode,
  ): boolean => {
    const key = sessionKey(providerSessionId, mode);
    const listed = loaded.get(key) ?? new Map<string, number>();
    const previousNames = new Set(listed.keys());
    loaded.delete(key);
    for (const tool of selected) {
      const bytes = entryBytes(tool);
      if (mode === "compact" && bytes > COMPACT_DYNAMIC_MAX_BYTES) continue;
      listed.delete(tool.name);
      listed.set(tool.name, bytes);
    }
    if (mode === "compact") {
      let totalBytes = 0;
      for (const bytes of listed.values()) totalBytes += bytes;
      for (const oldest of listed.keys()) {
        if (totalBytes <= COMPACT_DYNAMIC_MAX_BYTES) break;
        const removedBytes = listed.get(oldest) ?? 0;
        listed.delete(oldest);
        totalBytes -= removedBytes;
      }
    }
    if (listed.size > 0) {
      loaded.set(key, listed);
    }
    for (const oldest of loaded.keys()) {
      if (loaded.size <= MAX_SESSIONS) break;
      loaded.delete(oldest);
    }
    if (listed.size !== previousNames.size) return true;
    for (const name of listed.keys()) {
      if (!previousNames.has(name)) return true;
    }
    return false;
  };
  return McpToolExposure.of({
    search: Effect.fn("McpToolExposure.search")(function* (providerSessionId, query, mode) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const ranked = tools()
        .filter(
          (tool) =>
            tool.name !== TOOL_SEARCH &&
            (mode !== "compact" || !COMPACT_EAGER_TOOLS.has(tool.name)),
        )
        .map((tool) => ({ tool, score: score(tool, terms) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((match) => match.tool);
      const found = selectMatches(ranked, mode);
      if (mode !== undefined) {
        const toLoad =
          mode === "deferred" ? found.filter((tool) => !DIRECT_TOOLS.has(tool.name)) : found;
        if (toLoad.length > 0 && load(providerSessionId, toLoad, mode)) {
          yield* announceListChanged();
        }
      }
      return found.map(({ name, description }) => ({ name, description }));
    }),
    isListed: (providerSessionId, tool, mode) =>
      eagerToolsFor(mode).has(tool) ||
      loaded.get(sessionKey(providerSessionId, mode))?.has(tool) === true,
  });
};
