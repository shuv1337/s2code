import type { McpServerConfig, ProjectId } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Which threads a server's binding admits, or null when every Full access thread gets it. */
export function mcpServerAudience(
  config: Pick<McpServerConfig, "projectIds" | "excludeSubagents">,
  projectTitle: (id: ProjectId) => string | undefined,
  resolve: MFunctionType = mFallback,
): string | null {
  const projects = config.projectIds ?? [];
  const parts = [
    ...(projects.length > 0
      ? [
          resolve(
            msg("Only in {projects}", {
              projects: projects.map((id) => projectTitle(id) ?? id).join(", "),
            }),
          ),
        ]
      : []),
    ...(config.excludeSubagents === true ? [resolve(msg("Not for subagents"))] : []),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}
