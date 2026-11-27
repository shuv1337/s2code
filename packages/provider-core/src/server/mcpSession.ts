import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Sent by MCP clients that need T3 to curate their listed toolset.
 * `deferred` lists a minimal direct set plus `tool_search`; `compact` lists a
 * curated core set plus `tool_search` for clients with an eager schema cap.
 * `deferred-proxy` keeps a fixed list with schema search and `tool_call`.
 */
export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";

export type McpToolExposureMode = "deferred" | "compact" | "deferred-proxy";

export function parseMcpToolExposureMode(
  value: string | ReadonlyArray<string> | undefined,
): McpToolExposureMode | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed === "deferred" || trimmed === "compact" || trimmed === "deferred-proxy"
    ? trimmed
    : undefined;
}

/**
 * A remote MCP server from Settings, reached through T3's proxy with the
 * session's own `authorizationHeader`; the upstream credential never leaves T3.
 */
export interface SharedMcpServer {
  /** Already namespaced; use it verbatim as the harness entry name. */
  readonly name: string;
  readonly endpoint: string;
}

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** Each needs its own harness server entry: T3's pre-approvals must not cover its tools. */
  readonly sharedMcpServers?: ReadonlyArray<SharedMcpServer>;
  /** True while a delegated task this thread started will wake it with its result. */
  readonly hasPendingWake?: Effect.Effect<boolean>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
