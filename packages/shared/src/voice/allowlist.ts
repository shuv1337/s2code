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
const VOICE_SIDE_EFFECT_TOOLS = new Set<string>([
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_thread_update",
  "t3_thread_configure",
]);

/** Long-running tools: return immediately, then wait and speak a short summary. */
const VOICE_LONG_RUNNING_TOOLS = new Set<string>(["t3_thread_launch", "t3_thread_send"]);

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

/**
 * strip: hub schema rejects environmentId.
 * keep: explicit id only. Fleet discovery stays on the hub.
 * fill: copy defaultEnvironmentId when omitted, including thread read,
 * wait, and worktree list so a peer launch can be followed.
 */
export type VoiceEnvironmentPolicy = "strip" | "keep" | "fill";

export interface VoiceToolInputSchema {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
}

const VOICE_ENVIRONMENT_POLICY: Readonly<Record<string, VoiceEnvironmentPolicy>> = {
  t3_environment_links: "strip",
  t3_environment_read: "keep",
  t3_project_list: "keep",
  t3_project_read: "keep",
  t3_thread_list: "keep",
  t3_thread_search: "keep",
  t3_thread_read: "fill",
  t3_worktree_list: "fill",
  t3_worktree_status: "strip",
  t3_background_wait: "strip",
  t3_preview_list: "strip",
  t3_preview_close: "strip",
  t3_worktree_handoff: "strip",
  t3_environment_link: "keep",
  t3_environment_unlink: "keep",
  t3_thread_launch: "fill",
  t3_thread_send: "fill",
  t3_thread_interrupt: "fill",
  t3_thread_update: "fill",
  t3_thread_configure: "fill",
  t3_thread_wait: "fill",
  t3_pending_request: "fill",
  t3_queue: "fill",
  t3_workflow_stop: "fill",
  t3_thread_transfer: "fill",
  t3_project_create: "fill",
  t3_project_clone: "fill",
};

/**
 * Hub tools that accept clientRequestId. The voice call id always wins.
 * t3_pending_request is absent: its schema rejects the key.
 */
const VOICE_CLIENT_REQUEST_ID_TOOLS = new Set<string>([
  "t3_thread_send",
  "t3_thread_launch",
  "t3_thread_interrupt",
  "t3_thread_update",
  "t3_environment_link",
]);

const schemaAcceptsProperty = (schema: VoiceToolInputSchema, key: string): boolean | undefined => {
  const properties = schema.properties;
  if (properties && Object.prototype.hasOwnProperty.call(properties, key)) return true;
  if (schema.additionalProperties === true) return true;
  if (properties || schema.additionalProperties === false) return false;
  return undefined;
};

/** MCP input schema wins over allowlist metadata when both are present. */
export const environmentPolicyFor = (
  tool: string,
  schema?: VoiceToolInputSchema,
): VoiceEnvironmentPolicy => {
  const fallback = VOICE_ENVIRONMENT_POLICY[tool] ?? "strip";
  if (!schema) return fallback;
  const accepts = schemaAcceptsProperty(schema, "environmentId");
  if (accepts === undefined) return fallback;
  if (!accepts) return "strip";
  return fallback === "strip" ? "keep" : fallback;
};

export type ClientRequestIdPolicy = "overwrite" | "strip";

export const clientRequestIdPolicyFor = (
  tool: string,
  schema?: VoiceToolInputSchema,
): ClientRequestIdPolicy => {
  if (schema) {
    const accepts = schemaAcceptsProperty(schema, "clientRequestId");
    if (accepts === false) return "strip";
    if (accepts === true) return "overwrite";
  }
  return VOICE_CLIENT_REQUEST_ID_TOOLS.has(tool) ? "overwrite" : "strip";
};

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
