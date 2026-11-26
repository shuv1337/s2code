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

const MAX_RESULTS = 10;
// Sessions that ended are never reported here, so keep only the newest.
const MAX_SESSIONS = 256;

export interface ListedTool {
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
    ) => Effect.Effect<ReadonlyArray<ListedTool>>;
    readonly isListed: (
      providerSessionId: string,
      tool: string,
      mode?: McpToolExposureMode,
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

export const make = (
  tools: () => ReadonlyArray<ListedTool>,
  announceListChanged: () => Effect.Effect<void>,
) => {
  const loaded = new Map<string, Set<string>>();
  const load = (providerSessionId: string, names: ReadonlyArray<string>) => {
    const listed = loaded.get(providerSessionId) ?? new Set<string>();
    loaded.delete(providerSessionId);
    loaded.set(providerSessionId, listed);
    for (const name of names) listed.add(name);
    for (const oldest of loaded.keys()) {
      if (loaded.size <= MAX_SESSIONS) break;
      loaded.delete(oldest);
    }
  };
  return McpToolExposure.of({
    search: Effect.fn("McpToolExposure.search")(function* (providerSessionId, query) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const found = tools()
        .filter((tool) => tool.name !== TOOL_SEARCH)
        .map((tool) => ({ tool, score: score(tool, terms) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((match) => match.tool);
      if (found.length > 0) {
        load(
          providerSessionId,
          found.map((tool) => tool.name),
        );
        yield* announceListChanged();
      }
      return found;
    }),
    isListed: (providerSessionId, tool, mode = "deferred") =>
      (mode === "compact" ? COMPACT_EAGER_TOOLS : DIRECT_TOOLS).has(tool) ||
      loaded.get(providerSessionId)?.has(tool) === true,
  });
};
