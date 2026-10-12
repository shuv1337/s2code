import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { WatchThreadListQuery } from "./environmentHttp.ts";
import { OrchestrationV2Command } from "./orchestrationV2.ts";
import {
  WatchAdmission,
  WatchCommandEnvelope,
  WatchCommandReceipt,
  WatchPairingStartRequest,
  WatchPairingStartResponse,
  WatchPairingTokenRequest,
  WatchPairingTokenResponse,
} from "./watch.ts";

const envelope = {
  protocolVersion: 1,
  commandId: "5398acb4-fb8b-4dcd-b735-2e59bfa812f5",
  messageId: "9fb0ac02-b327-4a3c-890a-c9b840fabdb6",
  environmentId: "environment-1",
  threadId: "thread-1",
  text: "Continue the task",
  notAfter: "2026-10-10T20:00:00.000Z",
};
const decodeEnvelope = Schema.decodeUnknownSync(WatchCommandEnvelope);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const encodeCommand = Schema.encodeSync(OrchestrationV2Command);
const decodePairingStart = Schema.decodeUnknownSync(WatchPairingStartResponse);
const encodePairingStart = Schema.encodeSync(WatchPairingStartResponse);
const decodePairingToken = Schema.decodeUnknownSync(WatchPairingTokenResponse);
const encodePairingToken = Schema.encodeSync(WatchPairingTokenResponse);

describe("Watch command envelope", () => {
  it.each(["send", "queue", "steer"])("accepts a valid %s command", (action) => {
    const decoded = decodeEnvelope({ ...envelope, action, targetRunId: "run-1" });
    expect(decoded.action).toBe(action);
    expect(DateTime.formatIso(decoded.notAfter)).toBe(envelope.notAfter);
  });

  it("requires a target for steer, but not send or queue", () => {
    expect(() => decodeEnvelope({ ...envelope, action: "steer" })).toThrow();
    expect(decodeEnvelope({ ...envelope, action: "send" }).action).toBe("send");
    expect(decodeEnvelope({ ...envelope, action: "queue" }).action).toBe("queue");
  });

  it("rejects unknown actions, invalid timestamps, and non-UUID client ids", () => {
    expect(() => decodeEnvelope({ ...envelope, action: "restart" })).toThrow();
    expect(() => decodeEnvelope({ ...envelope, action: "send", notAfter: "tomorrow" })).toThrow();
    expect(() => decodeEnvelope({ ...envelope, action: "send", commandId: "cmd-1" })).toThrow();
    expect(() => decodeEnvelope({ ...envelope, action: "send", messageId: "msg-1" })).toThrow();
  });

  it("counts Unicode scalars rather than UTF-16 units without truncating", () => {
    const text = "😀".repeat(8_000);
    expect(decodeEnvelope({ ...envelope, action: "send", text }).text).toBe(text);
    expect(() => decodeEnvelope({ ...envelope, action: "send", text: `${text}a` })).toThrow();
    expect(() =>
      decodeEnvelope({ ...envelope, action: "send", text: "a".repeat(8_001) }),
    ).toThrow();
    expect(() => decodeEnvelope({ ...envelope, action: "send", text: "\ud800" })).toThrow();
  });
});

describe("Watch dispatch admission", () => {
  const dispatch = {
    type: "message.dispatch",
    commandId: "command-1",
    threadId: "thread-1",
    messageId: "message-1",
    createdBy: "user",
    creationSource: "mobile",
    text: "Hello",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  };

  it("preserves existing dispatch commands with neither optional field", () => {
    expect(decodeCommand(dispatch)).toEqual(dispatch);
  });

  it("accepts and retains admission and the persisted no-follow-up policy", () => {
    const command = {
      ...dispatch,
      dispatchMode: { type: "steer_active", targetRunId: "run-1" },
      admission: {
        kind: "watch",
        action: "steer",
        constraint: { type: "requireNativeSteerOf", targetRunId: "run-1" },
        notAfter: envelope.notAfter,
        steerFollowUpPolicy: "none",
      },
      steerFollowUpPolicy: "none",
    };
    const decoded = decodeCommand(command);
    expect(encodeCommand(decoded)).toEqual(command);
  });

  it("rejects mismatched action constraints and native steer without its target", () => {
    const decode = Schema.decodeUnknownSync(WatchAdmission);
    const base = { kind: "watch", notAfter: envelope.notAfter, steerFollowUpPolicy: "none" };
    expect(() =>
      decode({ ...base, action: "send", constraint: { type: "requireActive" } }),
    ).toThrow();
    expect(() =>
      decode({ ...base, action: "steer", constraint: { type: "requireNativeSteerOf" } }),
    ).toThrow();
  });
});

describe("Watch HTTP DTOs", () => {
  it("bounds a decoded page size to integer values from 1 through 50", () => {
    const decode = Schema.decodeUnknownSync(WatchThreadListQuery);
    expect(decode({})).toEqual({});
    expect(decode({ limit: "50" })).toEqual({ limit: 50 });
    for (const limit of ["0", "51", "1.5", "bad"]) {
      expect(() => decode({ limit })).toThrow();
    }
  });

  it("requires typed rejection errors and prevents contradictory receipt states", () => {
    const decode = Schema.decodeUnknownSync(WatchCommandReceipt);
    const rejected = {
      commandId: envelope.commandId,
      threadId: envelope.threadId,
      action: "send",
      status: "rejected",
      acceptedAt: null,
      resultSequence: null,
      observed: { activeRunId: "run-1", activity: "running" },
      error: { code: "thread_busy", message: "Thread has an active run" },
    };
    expect(decode(rejected)).toEqual(rejected);
    expect(() => decode({ ...rejected, error: null })).toThrow();
    expect(() => decode({ ...rejected, error: { code: "other", message: "Unknown" } })).toThrow();
    expect(() => decode({ ...rejected, status: "accepted" })).toThrow();
  });

  it("distinguishes a committed-then-failed command from acceptance and rejection", () => {
    const decode = Schema.decodeUnknownSync(WatchCommandReceipt);
    const committed = {
      commandId: envelope.commandId,
      threadId: envelope.threadId,
      action: "steer",
      acceptedAt: "2026-10-10T21:39:05.000Z",
      resultSequence: 12,
      observed: null,
    };
    const failed = {
      ...committed,
      status: "failed",
      error: { code: "stale_target", message: "Target run finished first" },
    };
    expect(decode(failed).status).toBe("failed");
    expect(() => decode({ ...failed, error: null })).toThrow();
    expect(() => decode({ ...failed, acceptedAt: null, resultSequence: null })).toThrow();
    expect(() => decode({ ...committed, status: "accepted", error: failed.error })).toThrow();
  });
});

describe("Watch device pairing", () => {
  it("trims and bounds the client label and requires protocol version 1", () => {
    const decode = Schema.decodeUnknownSync(WatchPairingStartRequest);
    expect(decode({ protocolVersion: 1 })).toEqual({ protocolVersion: 1 });
    expect(decode({ protocolVersion: 1, clientLabel: "  Wrist  " })).toEqual({
      protocolVersion: 1,
      clientLabel: "Wrist",
    });
    expect(
      decode({ protocolVersion: 1, clientLabel: ` ${"a".repeat(64)} ` }).clientLabel,
    ).toHaveLength(64);
    expect(() => decode({ protocolVersion: 1, clientLabel: "a".repeat(65) })).toThrow();
    expect(() => decode({ protocolVersion: 2 })).toThrow();
    const decodeToken = Schema.decodeUnknownSync(WatchPairingTokenRequest);
    expect(decodeToken({ protocolVersion: 1, deviceCode: "abc" }).deviceCode).toBe("abc");
    expect(() => decodeToken({ protocolVersion: 1, deviceCode: "" })).toThrow();
  });

  it("round-trips the start response with a millisecond UTC expiry", () => {
    const response = {
      deviceCode: "Zk3n9mCq1x0A8vRZp2yHq7cV5bT4wL6sJ1uE0oN3dKg",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-10-12T08:44:00.000Z",
      interval: 5,
      environment: { id: "environment-1", label: "Studio Mac" },
    };
    expect(encodePairingStart(decodePairingStart(response))).toEqual(response);
  });

  it.each([
    { status: "pending" },
    { status: "slow_down", interval: 10 },
    { status: "approved", credential: "watch.e30", expiresAt: "2026-10-12T08:49:00.000Z" },
    { status: "denied" },
    { status: "expired" },
  ])("decodes and re-encodes the $status poll result", (response) => {
    const decoded = decodePairingToken(response);
    expect(decoded.status).toBe(response.status);
    expect(encodePairingToken(decoded)).toEqual(response);
  });

  it("rejects unknown statuses and incomplete variants", () => {
    const decode = decodePairingToken;
    expect(() => decode({ status: "authorization_pending" })).toThrow();
    expect(() => decode({ status: "slow_down" })).toThrow();
    expect(() => decode({ status: "slow_down", interval: 0 })).toThrow();
    expect(() => decode({ status: "approved", credential: "watch.e30" })).toThrow();
  });
});
