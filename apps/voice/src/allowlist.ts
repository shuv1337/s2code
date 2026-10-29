/**
 * Voice MCP allowlist. Destructive / link / create tools stay OFF this set
 * entirely (Cap decision: confirm-destructive-only, and keep them off the
 * allowlist regardless). Enforcement is hard reject in the tool bridge —
 * never rely on the model prompt alone.
 */

/** Tools the voice client may call on the hub MCP. */
export const VOICE_TOOL_ALLOWLIST = [
  "t3_environment_read",
  "t3_environment_links",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_search",
  "t3_thread_read",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_thread_update",
  "t3_thread_configure",
  "t3_thread_wait",
  "t3_background_wait",
  "t3_pending_request",
  "t3_worktree_list",
  "t3_worktree_status",
] as const;

export type VoiceAllowedTool = (typeof VOICE_TOOL_ALLOWLIST)[number];

/**
 * Explicitly denied tools. Kept as a separate set so tests and the bridge can
 * reject by name even if someone later widens the allowlist by mistake.
 */
export const VOICE_DESTRUCTIVE_TOOLS = [
  "t3_project_delete",
  "t3_thread_transfer",
  "t3_workflow_stop",
  "t3_environment_unlink",
  "t3_worktree_handoff",
  "t3_project_create",
  "t3_project_clone",
  "t3_environment_link",
] as const;

export type VoiceDestructiveTool = (typeof VOICE_DESTRUCTIVE_TOOLS)[number];

/** Allowlisted tools that change remote/hub state (announce env before call). */
export const VOICE_SIDE_EFFECT_TOOLS = new Set<string>([
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_thread_update",
  "t3_thread_configure",
  "t3_pending_request",
]);

/** Long-running tools: fire, then wait, then speak a short summary. */
export const VOICE_LONG_RUNNING_TOOLS = new Set<string>(["t3_thread_launch"]);

const allowSet = new Set<string>(VOICE_TOOL_ALLOWLIST);
const destructiveSet = new Set<string>(VOICE_DESTRUCTIVE_TOOLS);

export const isAllowedVoiceTool = (tool: string): tool is VoiceAllowedTool => allowSet.has(tool);

export const isDestructiveVoiceTool = (tool: string): tool is VoiceDestructiveTool =>
  destructiveSet.has(tool);

export const isSideEffectVoiceTool = (tool: string): boolean => VOICE_SIDE_EFFECT_TOOLS.has(tool);

export const isLongRunningVoiceTool = (tool: string): boolean => VOICE_LONG_RUNNING_TOOLS.has(tool);

export type AllowlistDecision =
  | { readonly ok: true; readonly tool: VoiceAllowedTool }
  | {
      readonly ok: false;
      readonly tool: string;
      readonly reason: "destructive" | "not_allowlisted";
    };

/** Single gate used by the tool bridge before any MCP call. */
export const decideVoiceTool = (tool: string): AllowlistDecision => {
  if (isDestructiveVoiceTool(tool)) {
    return { ok: false, tool, reason: "destructive" };
  }
  if (!isAllowedVoiceTool(tool)) {
    return { ok: false, tool, reason: "not_allowlisted" };
  }
  return { ok: true, tool };
};
