import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import * as Audit from "./audit.ts";

it("formats allowlisted ndjson without args or secrets", () => {
  const line = Audit.formatVoiceToolAuditLine({
    ts: "2026-10-29T05:00:00.000Z",
    tool: "t3_thread_send",
    environmentId: "env-hub",
    threadId: "thread:1",
    status: "ok",
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual(["environmentId", "status", "threadId", "tool", "ts"]);
  expect(line).not.toContain("arguments");
  expect(line).not.toContain("secret");
  expect(line).not.toContain("Bearer");
});

it("extracts env/thread ids and ignores other keys", () => {
  expect(
    Audit.threadIdFromToolArgs({
      threadId: "t1",
      message: "do not log",
      token: "secret",
    }),
  ).toBe("t1");
  expect(
    Audit.environmentIdFromToolArgs({
      environmentId: "e1",
      pairingToken: "secret",
    }),
  ).toBe("e1");
  expect(Audit.threadIdFromToolArgs(null)).toBeNull();
});

it("appends voice-tool.ndjson under audit dir", async () => {
  const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-audit-"));
  await Audit.appendVoiceToolAudit(root, {
    ts: "2026-10-29T05:00:01.000Z",
    tool: "t3_thread_launch",
    environmentId: "env",
    threadId: null,
    status: "ok",
  });
  await Audit.appendVoiceToolAudit(root, {
    ts: "2026-10-29T05:00:02.000Z",
    tool: "t3_project_delete",
    environmentId: "env",
    threadId: null,
    status: "rejected_destructive",
  });
  const text = await NodeFS.readFile(Audit.voiceToolAuditPath(root), "utf8");
  const lines = text.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]!).status).toBe("rejected_destructive");
  expect(text).not.toContain("secret");
  await NodeFS.rm(root, { recursive: true, force: true });
});
