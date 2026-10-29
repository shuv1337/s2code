import { expect, it } from "vite-plus/test";

import {
  clientRequestIdPolicyFor,
  decideVoiceTool,
  environmentPolicyFor,
  isAllowedVoiceTool,
  isDestructiveVoiceTool,
  VOICE_DESTRUCTIVE_TOOLS,
  VOICE_TOOL_ALLOWLIST,
} from "./allowlist.ts";

it("allowlist includes read/list/launch/send/wait and excludes destructive", () => {
  expect(isAllowedVoiceTool("t3_thread_launch")).toBe(true);
  expect(isAllowedVoiceTool("t3_environment_links")).toBe(true);
  expect(isAllowedVoiceTool("t3_project_delete")).toBe(false);
  expect(isAllowedVoiceTool("t3_environment_link")).toBe(false);
  for (const tool of VOICE_DESTRUCTIVE_TOOLS) {
    expect(isAllowedVoiceTool(tool)).toBe(false);
    expect(isDestructiveVoiceTool(tool)).toBe(true);
  }
  for (const tool of VOICE_TOOL_ALLOWLIST) {
    expect(isDestructiveVoiceTool(tool)).toBe(false);
  }
});

it("decideVoiceTool hard-rejects destructive even if somehow listed", () => {
  const denied = decideVoiceTool("t3_project_delete");
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.reason).toBe("destructive");

  const guarded = decideVoiceTool("t3_project_create");
  expect(guarded.ok).toBe(false);
  if (!guarded.ok) expect(guarded.reason).toBe("needs_confirmation");
  expect(isAllowedVoiceTool("t3_queue")).toBe(true);

  const ok = decideVoiceTool("t3_thread_read");
  expect(ok.ok).toBe(true);

  const restart = decideVoiceTool("t3_thread_send", { mode: "restart" });
  expect(restart.ok).toBe(false);
  if (!restart.ok) expect(restart.reason).toBe("needs_confirmation");

  const cancel = decideVoiceTool("t3_queue", { action: "cancel" });
  expect(cancel.ok).toBe(false);
  if (!cancel.ok) expect(cancel.reason).toBe("needs_confirmation");

  const queueRead = decideVoiceTool("t3_queue", { action: "list" });
  expect(queueRead.ok).toBe(true);
});

it("environment policy follows the hub schema over allowlist metadata", () => {
  expect(environmentPolicyFor("t3_environment_links")).toBe("strip");
  expect(environmentPolicyFor("t3_environment_read")).toBe("keep");
  expect(environmentPolicyFor("t3_thread_list")).toBe("keep");
  expect(environmentPolicyFor("t3_thread_read")).toBe("fill");
  expect(environmentPolicyFor("t3_thread_wait")).toBe("fill");
  expect(environmentPolicyFor("t3_worktree_list")).toBe("fill");
  expect(environmentPolicyFor("t3_thread_send")).toBe("fill");
  expect(
    environmentPolicyFor("t3_thread_send", { properties: { threadId: { type: "string" } } }),
  ).toBe("strip");
  expect(environmentPolicyFor("t3_environment_links", { properties: {} })).toBe("strip");
  expect(clientRequestIdPolicyFor("t3_pending_request")).toBe("strip");
  expect(clientRequestIdPolicyFor("t3_thread_send")).toBe("overwrite");
  expect(
    clientRequestIdPolicyFor("t3_pending_request", {
      properties: { action: { type: "string" } },
      additionalProperties: false,
    }),
  ).toBe("strip");
});
