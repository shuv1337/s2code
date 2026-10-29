/**
 * Voice model function-call → allowlist → confirmation → MCP → audit.
 * Speaks environment name before side-effecting allowlisted calls.
 * Long-running (launch): fire, then wait, then return a short summary.
 */
import { decideVoiceTool, isLongRunningVoiceTool } from "./allowlist.ts";
import {
  appendVoiceToolAudit,
  environmentIdFromToolArgs,
  threadIdFromToolArgs,
  type VoiceToolAuditEntry,
} from "./audit.ts";
import {
  applyConfirmation,
  decideConfirmation,
  parseSpokenAnswer,
  type SpeakFn,
} from "./confirmation.ts";
import type { VoiceConfig } from "./config.ts";
import { labelForEnvironment } from "./config.ts";
import type { McpBridge, McpCallResult } from "./mcpBridge.ts";

export interface ToolBridgeRequest {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly callId?: string;
}

export interface ToolBridgeResult {
  readonly callId: string | undefined;
  readonly name: string;
  readonly status: string;
  readonly output: string;
  readonly rejected: boolean;
}

export interface ToolBridge {
  readonly handleFunctionCall: (request: ToolBridgeRequest) => Promise<ToolBridgeResult>;
  /** Feed user speech so a guarded tool can hear yes or no. */
  readonly hear: (utterance: string) => void;
  /** Background waits started by launch/send. */
  readonly drain: () => Promise<void>;
}

export interface CreateToolBridgeOptions {
  readonly config: VoiceConfig;
  readonly mcp: McpBridge;
  readonly speak: SpeakFn;
  readonly now?: () => Date;
  /** Override wait tool used after long-running fire. */
  readonly waitToolName?: string;
}

const truncateSummary = (value: unknown, max = 400): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
};

const audit = async (
  auditDir: string,
  entry: Omit<VoiceToolAuditEntry, "ts"> & { readonly ts?: string },
  now: () => Date,
): Promise<void> => {
  if (!auditDir) return;
  await appendVoiceToolAudit(auditDir, {
    ts: entry.ts ?? now().toISOString(),
    tool: entry.tool,
    environmentId: entry.environmentId,
    threadId: entry.threadId,
    status: entry.status,
  });
};

const UNSETTLED = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const payloadFrom = (content: unknown): Record<string, unknown> | undefined => {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof (part as { text: unknown }).text === "string"
    ) {
      try {
        const parsed = JSON.parse((part as { text: string }).text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* tool text was not JSON */
      }
    }
  }
  return undefined;
};

export const createToolBridge = (options: CreateToolBridgeOptions): ToolBridge => {
  const now = options.now ?? (() => new Date());
  const waitToolName = options.waitToolName ?? "t3_thread_wait";
  const labels = new Map<string, string>(Object.entries(options.config.environmentLabels));
  const watches: Promise<void>[] = [];
  let waiting: ((answer: "yes" | "no") => void) | undefined;
  let heard = "";

  const labelFor = (environmentId: string | null): string =>
    (environmentId ? labels.get(environmentId) : undefined) ??
    labelForEnvironment(options.config, environmentId) ??
    environmentId ??
    "the hub";

  const remember = (tool: string, content: unknown): void => {
    const payload = payloadFrom(content);
    if (!payload) return;
    if (tool === "t3_environment_read" && typeof payload.environmentId === "string") {
      const label = typeof payload.label === "string" ? payload.label : payload.environmentId;
      labels.set(payload.environmentId, label);
    }
    if (tool === "t3_environment_links" && Array.isArray(payload.links)) {
      if (typeof payload.environmentId === "string" && typeof payload.label === "string") {
        labels.set(payload.environmentId, payload.label);
      }
      for (const link of payload.links) {
        if (
          link &&
          typeof link === "object" &&
          typeof (link as { environmentId?: unknown }).environmentId === "string" &&
          typeof (link as { label?: unknown }).label === "string"
        ) {
          const row = link as { environmentId: string; label: string };
          labels.set(row.environmentId, row.label);
        }
      }
    }
  };

  const challenge = (): Promise<"yes" | "no"> => {
    heard = "";
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };

  const watchThread = (input: {
    readonly threadId: string;
    readonly environmentId: string | null;
    readonly label: string;
  }): Promise<void> =>
    (async () => {
      for (let poll = 0; poll < 4; poll += 1) {
        const waited = await options.mcp.callTool(waitToolName, {
          threadId: input.threadId,
          timeoutMs: 5_000,
          ...(input.environmentId ? { environmentId: input.environmentId } : {}),
        });
        await audit(
          options.config.auditDir,
          {
            tool: waitToolName,
            environmentId: input.environmentId,
            threadId: input.threadId,
            status: waited.status,
          },
          now,
        );
        const payload = payloadFrom(waited.content);
        const status = typeof payload?.status === "string" ? payload.status : undefined;
        const timedOut = payload?.timedOut === true;
        if (waited.ok && !timedOut && (status === undefined || !UNSETTLED.has(status))) {
          const detail =
            typeof payload?.summary === "string"
              ? payload.summary
              : truncateSummary(waited.content, 160);
          await options.speak(`Done on ${input.label}: ${status ?? "settled"}. ${detail}`);
          return;
        }
      }
      await options.speak(`${input.label}: the thread is still running.`);
    })().catch(async () => {
      await options.speak(`${input.label}: I lost track of the thread.`);
    });

  return {
    hear: (utterance) => {
      heard = `${heard} ${utterance}`.slice(-400);
      const answer = parseSpokenAnswer(heard);
      if (answer === undefined || waiting === undefined) return;
      const resolve = waiting;
      waiting = undefined;
      heard = "";
      resolve(answer);
    },
    drain: () => Promise.all(watches).then(() => undefined),
    handleFunctionCall: async (request) => {
      const callId = request.callId;
      const name = request.name;
      const args = request.arguments ?? {};
      const envId = environmentIdFromToolArgs(args) ?? options.config.defaultEnvironmentId;
      const threadId = threadIdFromToolArgs(args);
      const envLabel = labelFor(envId);

      const decision = decideVoiceTool(name);
      if (!decision.ok && decision.reason !== "needs_confirmation") {
        const status =
          decision.reason === "destructive" ? "rejected_destructive" : "rejected_not_allowlisted";
        const confirm = decideConfirmation({
          tool: name,
          environmentLabel: envLabel,
          args,
        });
        await applyConfirmation(confirm, options.speak);
        await audit(
          options.config.auditDir,
          {
            tool: name,
            environmentId: envId,
            threadId,
            status,
          },
          now,
        );
        return {
          callId,
          name,
          status,
          output: JSON.stringify({
            error: status,
            message:
              confirm.action === "reject" ? confirm.speak : `${name} is not available to voice.`,
          }),
          rejected: true,
        };
      }

      if (!decision.ok) {
        const confirm = decideConfirmation({
          tool: name,
          environmentLabel: envLabel,
          args,
        });
        const answerPromise = challenge();
        await applyConfirmation(confirm, options.speak);
        const answer = await answerPromise;
        if (answer !== "yes") {
          await audit(
            options.config.auditDir,
            {
              tool: name,
              environmentId: envId,
              threadId,
              status: "rejected_confirmation",
            },
            now,
          );
          return {
            callId,
            name,
            status: "rejected_confirmation",
            output: JSON.stringify({ error: "rejected_confirmation" }),
            rejected: true,
          };
        }
      }

      if (decision.ok) {
        const confirm = decideConfirmation({
          tool: name,
          environmentLabel: envLabel,
          args,
        });
        const gate = await applyConfirmation(confirm, options.speak);
        if (gate !== "proceed") {
          await audit(
            options.config.auditDir,
            {
              tool: name,
              environmentId: envId,
              threadId,
              status: "rejected_confirmation",
            },
            now,
          );
          return {
            callId,
            name,
            status: "rejected_confirmation",
            output: JSON.stringify({ error: "rejected_confirmation" }),
            rejected: true,
          };
        }
      } else {
        await options.speak(`On ${envLabel}.`);
      }

      const callArgs =
        envId && !("environmentId" in args) ? { ...args, environmentId: envId } : args;

      let result: McpCallResult;
      try {
        result = await options.mcp.callTool(name, callArgs);
      } catch {
        await audit(
          options.config.auditDir,
          {
            tool: name,
            environmentId: envId,
            threadId,
            status: "bridge_error",
          },
          now,
        );
        return {
          callId,
          name,
          status: "bridge_error",
          output: JSON.stringify({ error: "bridge_error" }),
          rejected: false,
        };
      }

      remember(name, result.content);
      await audit(
        options.config.auditDir,
        {
          tool: name,
          environmentId: envId,
          threadId,
          status: result.status,
        },
        now,
      );

      if (!result.ok) {
        return {
          callId,
          name,
          status: result.status,
          output: truncateSummary(result.content),
          rejected: false,
        };
      }

      if (isLongRunningVoiceTool(name)) {
        const payload = payloadFrom(result.content);
        const waitThreadId =
          (typeof payload?.threadId === "string" ? payload.threadId : undefined) ??
          threadId ??
          undefined;
        if (waitThreadId) {
          watches.push(
            watchThread({
              threadId: waitThreadId,
              environmentId: envId,
              label: envLabel,
            }),
          );
        }
      }

      return {
        callId,
        name,
        status: result.status,
        output: truncateSummary(result.content),
        rejected: false,
      };
    },
  };
};
