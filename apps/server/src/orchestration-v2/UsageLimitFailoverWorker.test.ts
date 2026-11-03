import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionRecords } from "./ProjectionStore.ts";
import { usageLimitFailoverCommand } from "./UsageLimitFailoverWorker.ts";

type Projection = ProjectionRecords<"runs" | "turnItems" | "runtimeRequests">;

const cursor = ProviderDriverKind.make("cursor");
const spent = ProviderInstanceId.make("cursor_spent");
const spare = ProviderInstanceId.make("cursor_spare");
const runId = RunId.make("run:failover");
const rootNodeId = NodeId.make("node:failover");
const at = DateTime.makeUnsafe("2026-11-02T00:00:00.000Z");
const selection = { instanceId: spent, model: "claude-opus-5-5" };

const run = {
  id: runId,
  threadId: ThreadId.make("thread:failover"),
  ordinal: 1,
  providerInstanceId: spent,
  modelSelection: selection,
  userMessageId: MessageId.make("message:user"),
  rootNodeId,
  status: "failed",
  startedAt: at,
  completedAt: at,
};
const failure = {
  type: "error",
  id: "turn-item:failure",
  runId,
  nodeId: rootNodeId,
  status: "failed",
  ordinal: 1,
  updatedAt: at,
  failure: { class: "usage_limit", retryable: false, message: "You've hit your usage limit." },
};
const projection = (overrides: {
  readonly thread?: object;
  readonly run?: object;
  readonly failure?: object;
  readonly runtimeRequests?: ReadonlyArray<object>;
}) =>
  ({
    thread: {
      id: run.threadId,
      projectId: ProjectId.make("project:failover"),
      providerInstanceId: spent,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      ...overrides.thread,
    },
    runs: [{ ...run, ...overrides.run }],
    turnItems: [{ ...failure, ...overrides.failure }],
    runtimeRequests: overrides.runtimeRequests ?? [],
  }) as unknown as Projection;

const provider: ServerProvider = {
  instanceId: spare,
  driver: cursor,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T00:00:00.000Z",
  models: [{ slug: selection.model, name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const pooled = { driver: cursor, enabled: true, disableOnUsageLimit: true };
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [spent]: pooled, [spare]: pooled },
} as typeof DEFAULT_SERVER_SETTINGS;

const command = (input: Parameters<typeof projection>[0]) =>
  usageLimitFailoverCommand({
    projection: projection(input),
    runId,
    providers: [provider],
    settings,
    now: Date.parse("2026-11-02T00:00:00.000Z"),
  });

describe("usage limit failover", () => {
  it("continues the failed run on a pooled peer", () => {
    expect(command({ thread: { snoozedUntil: at } })).toMatchObject({
      type: "message.dispatch",
      manualContinuationOfRunId: runId,
      failoverChainId: runId,
      modelSelection: { ...selection, instanceId: spare },
      dispatchMode: { type: "start_immediately" },
    });
  });

  it.each([
    ["a run already in a failover chain", { run: { failoverChainId: "run:0" } }],
    ["a delegated run", { run: { delegatedTaskId: "node:task" } }],
    ["a retryable rate limit", { failure: { failure: { ...failure.failure, retryable: true } } }],
    [
      "a limit not marked as spent quota",
      { failure: { failure: { class: "usage_limit", message: "Limited." } } },
    ],
    ["another failure class", { failure: { failure: { class: "provider_error", message: "x" } } }],
    ["a thread already moved", { thread: { providerInstanceId: spare } }],
    ["a settled thread", { thread: { settledOverride: "settled" } }],
    ["an archived thread", { thread: { archivedAt: at } }],
    ["a snoozed thread", { thread: { snoozedUntil: DateTime.makeUnsafe("2026-11-03T00:00:00Z") } }],
    ["a pending request", { runtimeRequests: [{ status: "pending" }] }],
  ])("leaves %s alone", (_name, overrides) => {
    expect(command(overrides)).toBeNull();
  });
});
