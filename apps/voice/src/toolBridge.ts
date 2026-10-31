/**
 * Voice model function-call → allowlist → confirmation → MCP → audit.
 * Speaks environment name before side-effecting allowlisted calls.
 * Long-running (launch): fire, then wait, then return a short summary.
 */
import {
  clientRequestIdPolicyFor,
  decideVoiceTool,
  environmentPolicyFor,
  isLongRunningVoiceTool,
  type VoiceToolInputSchema,
} from "@t3tools/shared/voice/allowlist";
import { appendVoiceToolAudit, threadIdFromToolArgs, type VoiceToolAuditEntry } from "./audit.ts";
import {
  applyConfirmation,
  decideConfirmation,
  parseSpokenAnswer,
  type SpeakFn,
} from "@t3tools/shared/voice/confirmation";
import type { VoiceConfig } from "./config.ts";
import { labelForEnvironment } from "./config.ts";
import type { McpBridge, McpCallResult } from "./mcpBridge.ts";
import {
  boundText,
  redactText,
  summarizeToolResult,
  toolPayload,
} from "@t3tools/shared/voice/resultSummary";

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
  /** Hub tools/list input schemas. Allowlist metadata is the fallback. */
  readonly toolSchemas?: Readonly<Record<string, VoiceToolInputSchema>>;
}

/**
 * Idempotency key is the GPT-Live call id. A model-supplied clientRequestId
 * does not win, and tools whose schema rejects the key never receive it.
 */
const applyClientRequestId = (
  name: string,
  args: Record<string, unknown>,
  callId: string | undefined,
  schema: VoiceToolInputSchema | undefined,
): Record<string, unknown> => {
  const policy = clientRequestIdPolicyFor(name, schema);
  if (policy === "strip") {
    if (!("clientRequestId" in args)) return args;
    const { clientRequestId: _ignored, ...rest } = args;
    return rest;
  }
  if (callId === undefined || callId.length === 0) return args;
  return { ...args, clientRequestId: callId };
};

const applyEnvironmentArg = (
  name: string,
  args: Record<string, unknown>,
  defaultEnvironmentId: string | null,
  schema: VoiceToolInputSchema | undefined,
): {
  readonly args: Record<string, unknown>;
  readonly environmentId: string | null;
  readonly filledDefault: boolean;
} => {
  const policy = environmentPolicyFor(name, schema);
  const explicit =
    typeof args.environmentId === "string" && args.environmentId.length > 0
      ? args.environmentId
      : null;
  const withoutEnvironment = (): Record<string, unknown> => {
    if (!("environmentId" in args)) return args;
    const { environmentId: _ignored, ...rest } = args;
    return rest;
  };
  if (policy === "strip")
    return { args: withoutEnvironment(), environmentId: null, filledDefault: false };
  if (policy === "keep" || explicit) {
    return {
      args: explicit === null ? withoutEnvironment() : args,
      environmentId: explicit,
      filledDefault: false,
    };
  }
  if (!defaultEnvironmentId) {
    return { args: withoutEnvironment(), environmentId: null, filledDefault: false };
  }
  return {
    args: { ...args, environmentId: defaultEnvironmentId },
    environmentId: defaultEnvironmentId,
    filledDefault: true,
  };
};

/** Tell the model which environment a filled default actually hit. */
const noteRoutedEnvironment = (
  output: string,
  environmentId: string | null,
  filledDefault: boolean,
): string => {
  if (!filledDefault || environmentId === null) return output;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) return JSON.stringify({ environmentId, content: parsed });
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.environmentId === "string") return output;
      return JSON.stringify({ environmentId, ...record });
    }
  } catch {
    return JSON.stringify({ environmentId, result: output });
  }
  return JSON.stringify({ environmentId, result: output });
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

const payloadFrom = toolPayload;

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
      return boundText(redactText(payload.summary.trim()), 160);
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
        const text = redactText((item as { text: string }).text.trim());
        if (text.length > 0) return boundText(text, 160);
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
      const schema = options.toolSchemas?.[name];
      const routed = applyEnvironmentArg(name, args, options.config.defaultEnvironmentId, schema);
      const envId = routed.environmentId;
      const threadId = threadIdFromToolArgs(args);
      const envLabel = labelFor(envId);

      const decision = decideVoiceTool(name, args);
      if (!decision.ok && decision.reason !== "needs_confirmation") {
        const status =
          decision.reason === "destructive" ? "rejected_destructive" : "rejected_not_allowlisted";
        const confirm = decideConfirmation({
          tool: name,
          environmentLabel: envLabel,
          args: routed.args,
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
          args: routed.args,
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
          args: routed.args,
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

      const callArgs = applyClientRequestId(name, routed.args, callId, schema);

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

      const modelOutput = (ok: boolean) =>
        noteRoutedEnvironment(
          summarizeToolResult({
            tool: name,
            content: result.content,
            maxChars: options.config.toolResultMaxChars,
            ...(ok ? {} : { ok: false }),
          }),
          envId,
          routed.filledDefault,
        );

      if (!result.ok) {
        return {
          callId,
          name,
          status: result.status,
          output: modelOutput(false),
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
        output: modelOutput(true),
        rejected: false,
      };
    },
  };
};
