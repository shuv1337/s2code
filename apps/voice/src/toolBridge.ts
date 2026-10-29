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
  /** How long a spoken yes stays valid. Default 20s. */
  readonly confirmTimeoutMs?: number;
  readonly scheduleTimeout?: (ms: number, onFire: () => void) => () => void;
}

/**
 * Idempotency key is the GPT-Live call id captured with the arguments.
 * A spoken yes does not replace those arguments.
 */
const clientRequestArgs = (
  name: string,
  args: Record<string, unknown>,
  callId: string | undefined,
): Record<string, unknown> => {
  if (callId === undefined || callId.length === 0 || args.clientRequestId !== undefined)
    return args;
  const respond = name === "t3_pending_request" && args.action === "respond";
  if (name !== "t3_thread_send" && name !== "t3_thread_launch" && !respond) return args;
  return { ...args, clientRequestId: callId };
};

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
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 20_000;
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((ms, onFire) => {
      const timer = setTimeout(onFire, ms);
      return () => clearTimeout(timer);
    });
  const labels = new Map<string, string>(Object.entries(options.config.environmentLabels));
  const watches: Promise<void>[] = [];
  let waiting: ((answer: "yes" | "no" | "timeout") => void) | undefined;
  let cancelTimer: (() => void) | undefined;
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

  const challenge = (): Promise<"yes" | "no" | "timeout" | "busy"> => {
    if (waiting !== undefined) return Promise.resolve("busy");
    heard = "";
    return new Promise((resolve) => {
      const finish = (answer: "yes" | "no" | "timeout") => {
        if (waiting !== finish) return;
        waiting = undefined;
        heard = "";
        cancelTimer?.();
        cancelTimer = undefined;
        resolve(answer);
      };
      waiting = finish;
      cancelTimer = scheduleTimeout(confirmTimeoutMs, () => finish("timeout"));
    });
  };

  const spokenDetail = (payload: Record<string, unknown> | undefined): string | undefined => {
    if (typeof payload?.summary === "string" && payload.summary.trim().length > 0) {
      return truncateSummary(payload.summary, 160);
    }
    const items = payload?.items;
    if (!Array.isArray(items)) return undefined;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        const text = (item as { text: string }).text.trim();
        if (text.length > 0) return truncateSummary(text, 160);
      }
    }
    return undefined;
  };

  const watchThread = (input: {
    readonly threadId: string;
    readonly environmentId: string | null;
    readonly label: string;
  }): Promise<void> =>
    (async () => {
      let saidRunning = false;
      for (let poll = 0; poll < 12; poll += 1) {
        const waited = await options.mcp.callTool(waitToolName, {
          threadId: input.threadId,
          timeoutMs: 15_000,
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
        const settled = waited.ok && !timedOut && (status === undefined || !UNSETTLED.has(status));
        if (settled) {
          const detail = spokenDetail(payload);
          const statusText = status ?? "settled";
          await options.speak(
            detail === undefined
              ? `Done on ${input.label}: ${statusText}.`
              : `Done on ${input.label}: ${statusText}. ${detail}`,
          );
          return;
        }
        if (!saidRunning && poll >= 1) {
          saidRunning = true;
          await options.speak(
            `${input.label}: thread ${input.threadId} is still running. I will check again.`,
          );
        }
      }
      await options.speak(
        `${input.label}: thread ${input.threadId} is still running. Ask me to check again.`,
      );
    })().catch(async () => {
      await options.speak(`${input.label}: I lost track of thread ${input.threadId}.`);
    });

  return {
    hear: (utterance) => {
      if (waiting === undefined) return;
      heard = `${heard} ${utterance}`.slice(-400);
      const answer = parseSpokenAnswer(heard);
      if (answer === undefined) return;
      waiting(answer);
    },
    drain: () => Promise.all(watches).then(() => undefined),
    handleFunctionCall: async (request) => {
      const callId = request.callId;
      const name = request.name;
      const args = request.arguments ?? {};
      const envId = environmentIdFromToolArgs(args) ?? options.config.defaultEnvironmentId;
      const threadId = threadIdFromToolArgs(args);
      const envLabel = labelFor(envId);

      const decision = decideVoiceTool(name, args);
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
        if (waiting !== undefined) {
          await options.speak("Another confirmation is already waiting.");
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
            output: JSON.stringify({ error: "rejected_confirmation", reason: "busy" }),
            rejected: true,
          };
        }
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

      const captured =
        envId && !("environmentId" in args) ? { ...args, environmentId: envId } : { ...args };
      const callArgs = clientRequestArgs(name, captured, callId);

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
