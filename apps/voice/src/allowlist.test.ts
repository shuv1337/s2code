import { expect, it } from "vite-plus/test";

import {
  decideVoiceTool,
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
});
