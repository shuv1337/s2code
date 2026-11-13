import type { McpServerConfig, ProjectId } from "@t3tools/contracts";

/** Which threads a server's binding admits, or null when every Full access thread gets it. */
export function mcpServerAudience(
  config: Pick<McpServerConfig, "projectIds" | "excludeSubagents">,
  projectTitle: (id: ProjectId) => string | undefined,
): string | null {
  const projects = config.projectIds ?? [];
  const parts = [
    ...(projects.length > 0
      ? [`Only in ${projects.map((id) => projectTitle(id) ?? id).join(", ")}`]
      : []),
    ...(config.excludeSubagents === true ? ["Not for subagents"] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}
