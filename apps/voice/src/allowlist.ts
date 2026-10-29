/**
 * Voice MCP allowlist. Guarded tools stay off this set and run only after a
 * spoken yes. Delete stays blocked. Enforcement is in the tool bridge.
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
  "t3_queue",
  "t3_worktree_list",
  "t3_worktree_status",
] as const;

export type VoiceAllowedTool = (typeof VOICE_TOOL_ALLOWLIST)[number];

/** Hard-blocked. Not on the confirm list, so voice never calls them. */
export const VOICE_DESTRUCTIVE_TOOLS = ["t3_project_delete"] as const;

/**
 * Off the default allowlist. The model may ask; the bridge runs them only
 * after an explicit spoken yes for that call.
 */
export const VOICE_CONFIRM_TOOLS = [
  "t3_workflow_stop",
  "t3_thread_transfer",
  "t3_worktree_handoff",
  "t3_project_create",
  "t3_project_clone",
  "t3_environment_link",
  "t3_environment_unlink",
  "t3_preview_list",
  "t3_preview_close",
] as const;

export type VoiceDestructiveTool = (typeof VOICE_DESTRUCTIVE_TOOLS)[number];

/** Allowlisted tools that change remote/hub state (announce env before call). */
export const VOICE_SIDE_EFFECT_TOOLS = new Set<string>([
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_thread_update",
  "t3_thread_configure",
]);

/** Long-running tools: return immediately, then wait and speak a short summary. */
export const VOICE_LONG_RUNNING_TOOLS = new Set<string>(["t3_thread_launch", "t3_thread_send"]);

const allowSet = new Set<string>(VOICE_TOOL_ALLOWLIST);
const destructiveSet = new Set<string>(VOICE_DESTRUCTIVE_TOOLS);
const confirmSet = new Set<string>(VOICE_CONFIRM_TOOLS);

export const isAllowedVoiceTool = (tool: string): tool is VoiceAllowedTool => allowSet.has(tool);

export const isDestructiveVoiceTool = (tool: string): tool is VoiceDestructiveTool =>
  destructiveSet.has(tool);

export const isConfirmVoiceTool = (tool: string): boolean => confirmSet.has(tool);

/** Restart and queue cancel are side effects that still need a spoken yes. */
export const needsSpokenConfirmation = (
  tool: string,
  args?: Readonly<Record<string, unknown>>,
): boolean => {
  if (isConfirmVoiceTool(tool)) return true;
  if (tool === "t3_thread_send" && args?.mode === "restart") return true;
  if (tool === "t3_queue" && args?.action === "cancel") return true;
  return false;
};

export const isSideEffectVoiceTool = (
  tool: string,
  args?: Readonly<Record<string, unknown>>,
): boolean => {
  if (isConfirmVoiceTool(tool)) return true;
  if (tool === "t3_queue") return args?.action !== "list" && args?.action !== "read";
  if (tool === "t3_pending_request") return args?.action === "respond";
  return VOICE_SIDE_EFFECT_TOOLS.has(tool);
};

export const isLongRunningVoiceTool = (tool: string): boolean => VOICE_LONG_RUNNING_TOOLS.has(tool);

export type AllowlistDecision =
  | { readonly ok: true; readonly tool: VoiceAllowedTool }
  | {
      readonly ok: false;
      readonly tool: string;
      readonly reason: "destructive" | "not_allowlisted" | "needs_confirmation";
    };

/** Single gate used by the tool bridge before any MCP call. */
export const decideVoiceTool = (
  tool: string,
  args?: Readonly<Record<string, unknown>>,
): AllowlistDecision => {
  if (needsSpokenConfirmation(tool, args)) {
    return { ok: false, tool, reason: "needs_confirmation" };
  }
  if (isDestructiveVoiceTool(tool)) {
    return { ok: false, tool, reason: "destructive" };
  }
  if (!isAllowedVoiceTool(tool)) {
    return { ok: false, tool, reason: "not_allowlisted" };
  }
  return { ok: true, tool };
};
