/**
 * Scripted text dry-run. t3_thread_list needs a projectId because this client
 * is not inside a thread. A missing project skips that call instead of failing
 * the whole run.
 */
import type { ToolBridge, ToolBridgeResult } from "./toolBridge.ts";

export interface ScriptedDryRunOptions {
  readonly projectId?: string;
}

export const cliFlag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
};

export const projectIdFromListOutput = (output: string): string | undefined => {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const projects = (parsed as { projects?: unknown }).projects;
    if (!Array.isArray(projects)) return undefined;
    for (const project of projects) {
      if (!project || typeof project !== "object") continue;
      const id =
        (project as { id?: unknown; projectId?: unknown }).id ??
        (project as { projectId?: unknown }).projectId;
      if (typeof id === "string" && id.length > 0) return id;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const skippedList = (message: string): ToolBridgeResult => ({
  callId: "dry_list",
  name: "t3_thread_list",
  status: "skipped_no_project",
  output: JSON.stringify({ error: "skipped_no_project", message }),
  rejected: false,
});

export const runScriptedTextDryRun = async (
  bridge: ToolBridge,
  options: ScriptedDryRunOptions = {},
): Promise<ToolBridgeResult[]> => {
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
    }
  }

  if (projectId === undefined) {
    results.push(skippedList("Pass --project-id, or t3_project_list must return a project."));
    return results;
  }

  results.push(
    await bridge.handleFunctionCall({
      name: "t3_thread_list",
      arguments: { projectId },
      callId: "dry_list",
    }),
  );
  return results;
};
