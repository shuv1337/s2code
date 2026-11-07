// @effect-diagnostics nodeBuiltinImport:off -- Evaluates the installed SDK bundle in an isolated VM without starting a provider.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { withCursorRetryDiagnostics, type CursorRetryDiagnostic } from "./cursorRetry.ts";

const checkpointError =
  "Cursor could not confirm that this answer was saved. Automatic replay was stopped; the next message will recover in a fresh Cursor session.";

interface CheckpointHandler {
  handleCheckpoint: (
    context: unknown,
    state: unknown,
    metadata?: { resumeEligibility: string },
  ) => Promise<void>;
  getLatestCheckpoint: () => unknown;
}

interface Attempt {
  attempt: number;
  action: { action: { case: string } };
  checkpointHandler: CheckpointHandler;
  notifyApplicationProgress: () => void;
}

// The SDK bundles this private loop; execute the installed implementation with inert transport dependencies.
function loadRetryLoop(format: "cjs" | "esm") {
  const require = NodeModule.createRequire(import.meta.url);
  const directory = NodePath.dirname(require.resolve("@cursor/sdk"));
  const source = NodeFS.readFileSync(NodePath.join(directory, "..", format, "305.js"), "utf8");
  const marker = source.indexOf(
    "checkpointHandler:r,runOptions:n,requestId:o,hooks:s,cancellation:i",
  );
  const start = source.lastIndexOf("async function ", marker);
  const end = source.indexOf("new Set([", marker);
  const loop = source.slice(start, end);
  const name = /^async function (\w+)/.exec(loop)![1]!;
  const initialDelay = /let c=(\w+);/.exec(loop)![1]!;
  const uuid = /y=\(0,(\w+)\.C\)\(\)/.exec(loop)![1]!;
  const proto = /g=new (\w+)\.QFf/.exec(loop)![1]!;
  const sameState = /(\w+)\(\(x=m\)\.turns/.exec(loop)![1]!;
  const errorClass = /error:new (\w+)\("Agent turn stopped/.exec(loop)![1]!;
  const guardPath = NodePath.join(directory, "..", "s2code-retry.cjs");
  const globals = {
    [initialDelay]: 0,
    [uuid]: { C: () => "retry-request" },
    [proto]: {
      QFf: function ConversationAction(input: object) {
        return input;
      },
      qKo: Object,
    },
    [sameState]: () => true,
    [errorClass]: Error,
    s2codeRetryGuard: NodeFS.existsSync(guardPath) ? require(guardPath) : undefined,
  };
  return NodeVM.runInNewContext(`${loop}; ${name}`, globals) as (input: object) => Promise<void>;
}

describe.each(["cjs", "esm"] as const)("Cursor SDK %s retry boundary", (format) => {
  it.each([
    {
      scenario: "original action",
      checkpoint: false,
      continuation: false,
      terminal: false,
      expectedAttempts: 1,
      failure: true,
    },
    {
      scenario: "older resumable checkpoint",
      checkpoint: true,
      continuation: false,
      terminal: false,
      expectedAttempts: 1,
      failure: true,
    },
    {
      scenario: "failed continuation after an answer",
      checkpoint: true,
      continuation: true,
      terminal: false,
      expectedAttempts: 1,
      failure: true,
    },
    {
      scenario: "persisted terminal checkpoint",
      checkpoint: true,
      continuation: false,
      terminal: true,
      expectedAttempts: 1,
      failure: false,
    },
    {
      scenario: "mid-turn reconnect",
      checkpoint: true,
      continuation: false,
      terminal: false,
      expectedAttempts: 2,
      failure: false,
      midTurn: true,
    },
    {
      scenario: "terminal checkpoint write failure",
      checkpoint: true,
      continuation: false,
      terminal: true,
      writeFailure: true,
      expectedAttempts: 1,
      failure: true,
    },
    {
      scenario: "user interruption after an answer",
      checkpoint: false,
      continuation: false,
      terminal: false,
      thrown: { message: "Request cancelled", kind: "CancelledError" },
      expectedAttempts: 1,
      failure: true,
    },
    {
      scenario: "authentication failure after an answer",
      checkpoint: true,
      continuation: false,
      terminal: false,
      thrown: { message: "Sign in to Cursor again", kind: "AuthenticationError" },
      expectedAttempts: 1,
      failure: true,
    },
  ])("handles $scenario without repeating completed work", async (fixture) => {
    const run = loadRetryLoop(format);
    const actions: string[] = [];
    const answers: string[] = [];
    const diagnostics: CursorRetryDiagnostic[] = [];
    let toolExecutions = 0;
    const state = { turns: [], rootPromptMessagesJson: [] };
    const interaction = {
      sendUpdate: async (_context: unknown, update: { message: { case: string } }) => {
        if (update.message.case === "turnEnded") answers.push("answer");
      },
    };
    const input = {
      ctx: { canceled: false, signal: new AbortController().signal },
      state,
      action: { action: { case: "userMessageAction" } },
      requestId: "original-request",
      runOptions: { enableAgentRetries: true },
      interaction,
      checkpointError: (cause: unknown, requestId: string) =>
        Object.assign(new Error(checkpointError, { cause }), {
          requestId,
          kind: "NonRetriableError",
        }),
      checkpointHandler: {
        handleCheckpoint: async (
          _context: unknown,
          _state: unknown,
          metadata: { resumeEligibility: string },
        ) => {
          if (
            "writeFailure" in fixture &&
            fixture.writeFailure &&
            metadata.resumeEligibility === "ineligible_terminal_turn"
          ) {
            throw Object.assign(new Error("Checkpoint persistence failed"), {
              code: "SQLITE_FULL",
            });
          }
        },
        getLatestCheckpoint: () => state,
      },
      cancellation: { toCancelledError: () => new Error("cancelled") },
      hooks: {
        classify: (error: unknown, info: { attempt: number }) =>
          "thrown" in fixture
            ? {
                action: "throw",
                error: Object.assign(new Error(fixture.thrown.message, { cause: error }), {
                  kind: fixture.thrown.kind,
                }),
              }
            : info.attempt < 1
              ? {
                  action: "retry",
                  immediate: true,
                  countAsTransportError: true,
                  countAsServerError: false,
                }
              : { action: "throw", error },
        runAttempt: async (attempt: Attempt) => {
          actions.push(attempt.action.action.case);
          if (fixture.checkpoint) {
            await attempt.checkpointHandler.handleCheckpoint({}, state, {
              resumeEligibility: "eligible",
            });
          }
          attempt.notifyApplicationProgress();
          if ("midTurn" in fixture && fixture.midTurn && attempt.attempt === 0) {
            throw new Error("ECONNRESET before the answer");
          }
          toolExecutions++;
          await interaction.sendUpdate({}, { message: { case: "turnEnded" } });
          if (fixture.terminal) {
            await attempt.checkpointHandler.handleCheckpoint({}, state, {
              resumeEligibility: "ineligible_terminal_turn",
            });
          }
          if (fixture.continuation)
            await interaction.sendUpdate({}, { message: { case: "textDelta" } });
          if (attempt.attempt === 0) throw new Error("ECONNRESET after the answer");
        },
      },
    };
    const result = withCursorRetryDiagnostics(
      (event) => diagnostics.push(event),
      () => run(input),
    );
    if (fixture.failure)
      await expect(result).rejects.toThrow(
        "thrown" in fixture ? fixture.thrown.message : checkpointError,
      );
    else await result;
    expect(actions).toHaveLength(fixture.expectedAttempts);
    expect(toolExecutions).toBe(1);
    expect(answers).toEqual(["answer"]);
    if (fixture.expectedAttempts === 2)
      expect(actions).toEqual(["userMessageAction", "resumeAction"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.originalRequestId).toBe("original-request");
    expect(diagnostics[0]?.decision).toBe(
      "thrown" in fixture
        ? "throw"
        : fixture.failure
          ? "blocked_after_turn_ended"
          : fixture.terminal
            ? "completed_from_checkpoint"
            : "retry",
    );
    if ("thrown" in fixture) {
      await expect(result).rejects.toMatchObject({ kind: fixture.thrown.kind });
      expect(diagnostics[0]?.cause).toMatchObject({ message: "ECONNRESET after the answer" });
    }
    if ("writeFailure" in fixture) {
      expect(diagnostics[0]?.checkpoint).toBe("eligible");
      expect(diagnostics[0]?.cause).toMatchObject({ code: "SQLITE_FULL" });
    }
  });

  it("allows stop-hook continuations on the original connection", async () => {
    const run = loadRetryLoop(format);
    const updates: string[] = [];
    const interaction = {
      sendUpdate: async (_context: unknown, update: { message: { case: string } }) => {
        updates.push(update.message.case);
      },
    };
    await run({
      ctx: { canceled: false },
      requestId: "continuation",
      runOptions: {},
      interaction,
      checkpointHandler: {},
      cancellation: {},
      hooks: {
        runAttempt: async () => {
          for (const type of ["turnEnded", "toolCallStarted", "textDelta", "turnEnded"]) {
            await interaction.sendUpdate({}, { message: { case: type } });
          }
        },
      },
    });
    expect(updates).toEqual(["turnEnded", "toolCallStarted", "textDelta", "turnEnded"]);
  });
});
