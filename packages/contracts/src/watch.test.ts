import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { WatchThreadListQuery } from "./environmentHttp.ts";
import { OrchestrationV2Command } from "./orchestrationV2.ts";
import { WatchAdmission, WatchCommandEnvelope, WatchCommandReceipt } from "./watch.ts";

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
});
