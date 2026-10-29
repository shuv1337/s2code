import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import * as PeerForwardAudit from "./PeerForwardAudit.ts";

it("formats an allowlisted ndjson line without args or secrets", () => {
  const line = PeerForwardAudit.formatPeerForwardAuditLine({
    ts: "2026-10-29T04:40:00.000Z",
    tool: "t3_thread_read",
    environmentId: "1671bfb5-9801-4fe2-8861-4e898e29d468",
    threadId: "mcp:launch:abc",
    status: "ok",
    durationMs: 42,
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual([
    "durationMs",
    "environmentId",
    "status",
    "threadId",
    "tool",
    "ts",
  ]);
  expect(parsed.tool).toBe("t3_thread_read");
  expect(parsed.status).toBe("ok");
  expect(line).not.toContain("arguments");
  expect(line).not.toContain("secret");
  expect(line).not.toContain("pairing");
});

it("extracts threadId from forward params and ignores other keys", () => {
  expect(
    PeerForwardAudit.threadIdFromForwardParams({
      threadId: "thread:one",
      message: "do not log me",
      token: "secret-value",
    }),
  ).toBe("thread:one");
  expect(PeerForwardAudit.threadIdFromForwardParams({ message: "x" })).toBeNull();
  expect(PeerForwardAudit.threadIdFromForwardParams(null)).toBeNull();
});

it("appends one ndjson line under the userdata logs dir", async () => {
  const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-forward-audit-"));
  const logsDir = NodePath.join(root, "userdata", "logs");
  await PeerForwardAudit.appendPeerForwardAudit(logsDir, {
    ts: "2026-10-29T04:40:01.000Z",
    tool: "t3_thread_launch",
    environmentId: "env-peer",
    threadId: null,
    status: "ok",
    durationMs: 12,
  });
  await PeerForwardAudit.appendPeerForwardAudit(logsDir, {
    ts: "2026-10-29T04:40:02.000Z",
    tool: "t3_thread_wait",
    environmentId: "env-peer",
    threadId: "thread:wait",
    status: "capability_denied",
    durationMs: 3,
  });
  const text = await NodeFS.readFile(PeerForwardAudit.peerForwardAuditPath(logsDir), "utf8");
  const lines = text.trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!).tool).toBe("t3_thread_launch");
  expect(JSON.parse(lines[1]!).status).toBe("capability_denied");
  expect(text).not.toContain("secret");
  await NodeFS.rm(root, { recursive: true, force: true });
});
