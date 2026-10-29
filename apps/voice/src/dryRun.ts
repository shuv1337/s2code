/**
 * Scripted text dry-run. t3_thread_list needs a projectId because this client
 * is not inside a thread. A missing project skips that call instead of failing
 * the whole run.
 */
import type { ToolBridge, ToolBridgeResult } from "./toolBridge.ts";

export interface ScriptedDryRunOptions {
  readonly projectId?: string;
}

export interface ScriptedDryRunReport {
  readonly projectId: string | null;
  readonly results: readonly ToolBridgeResult[];
}

export const cliFlag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
};

const idString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const projectIdFromListOutput = (output: string): string | undefined => {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { projectId?: unknown; projects?: unknown };
      const direct = idString(record.projectId);
      if (direct) return direct;
      if (Array.isArray(record.projects)) {
        for (const project of record.projects) {
          if (!project || typeof project !== "object") continue;
          const id =
            idString((project as { id?: unknown }).id) ??
            idString((project as { projectId?: unknown }).projectId);
          if (id) return id;
        }
      }
    }
  } catch {
    /* truncated JSON still may contain the first id */
  }
  return output.match(/"(?:projectId|id)"\s*:\s*"([^"\\]+)"/u)?.[1];
};

const skippedList = (status: string, message: string): ToolBridgeResult => ({
  callId: "dry_list",
  name: "t3_thread_list",
  status,
  output: JSON.stringify({ error: status, message }),
  rejected: false,
});

export const runScriptedTextDryRun = async (
  bridge: ToolBridge,
  options: ScriptedDryRunOptions = {},
): Promise<ScriptedDryRunReport> => {
  const results: ToolBridgeResult[] = [];
  results.push(
    await bridge.handleFunctionCall({
      name: "t3_environment_links",
      arguments: {},
      callId: "dry_links",
    }),
  );
  results.push(
    await bridge.handleFunctionCall({
      name: "t3_project_delete",
      arguments: { projectId: "should-reject" },
      callId: "dry_delete",
    }),
  );

  const flagged = options.projectId?.trim();
  let projectId = flagged && flagged.length > 0 ? flagged : undefined;
  if (projectId === undefined) {
    const listed = await bridge.handleFunctionCall({
      name: "t3_project_list",
      arguments: {},
      callId: "dry_projects",
    });
    results.push(listed);
    if (!listed.rejected && listed.status === "ok") {
      projectId = projectIdFromListOutput(listed.output);
      if (projectId === undefined) {
        let readable = false;
        try {
          JSON.parse(listed.output);
          readable = true;
        } catch {
          readable = false;
        }
        const status = readable ? "skipped_no_project" : "unreadable_project_list";
        results.push(
          skippedList(
            status,
            readable
              ? "Pass --project-id, or t3_project_list must return a project."
              : "t3_project_list result was truncated before a project id. Pass --project-id or raise toolResultMaxChars.",
          ),
        );
        return { projectId: null, results };
      }
    }
  }

  if (projectId === undefined) {
    results.push(
      skippedList(
        "skipped_no_project",
        "Pass --project-id, or t3_project_list must return a project.",
      ),
    );
    return { projectId: null, results };
  }

  results.push(
    await bridge.handleFunctionCall({
      name: "t3_thread_list",
      arguments: { projectId },
      callId: "dry_list",
    }),
  );
  return { projectId, results };
};
