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
import { applyConfirmation, decideConfirmation, type SpeakFn } from "./confirmation.ts";
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

export const createToolBridge = (options: CreateToolBridgeOptions): ToolBridge => {
  const now = options.now ?? (() => new Date());
  const waitToolName = options.waitToolName ?? "t3_thread_wait";

  return {
    handleFunctionCall: async (request) => {
      const callId = request.callId;
      const name = request.name;
      const args = request.arguments ?? {};
      const envId = environmentIdFromToolArgs(args) ?? options.config.defaultEnvironmentId;
      const threadId = threadIdFromToolArgs(args);
      const envLabel = labelForEnvironment(options.config, envId);

      const decision = decideVoiceTool(name);
      if (!decision.ok) {
        const status =
          decision.reason === "destructive" ? "rejected_destructive" : "rejected_not_allowlisted";
        const confirm = decideConfirmation({
          tool: name,
          environmentLabel: envLabel,
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

      const confirm = decideConfirmation({
        tool: name,
        environmentLabel: envLabel,
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

      // Long-running: fire then wait and speak a short summary.
      if (isLongRunningVoiceTool(name)) {
        const launchedThread =
          threadIdFromToolArgs(result.content) ??
          (typeof result.content === "object" &&
          result.content !== null &&
          "threadId" in (result.content as object)
            ? String((result.content as { threadId: unknown }).threadId)
            : null);

        // Prefer thread id from structured text content if present.
        let waitThreadId = launchedThread ?? threadId;
        if (!waitThreadId && Array.isArray(result.content)) {
          for (const part of result.content) {
            if (
              part &&
              typeof part === "object" &&
              "text" in part &&
              typeof (part as { text: unknown }).text === "string"
            ) {
              try {
                const parsed = JSON.parse((part as { text: string }).text) as {
                  threadId?: string;
                  id?: string;
                };
                waitThreadId = parsed.threadId ?? parsed.id ?? null;
              } catch {
                /* ignore */
              }
            }
          }
        }

        if (waitThreadId) {
          const waitResult = await options.mcp.callTool(waitToolName, {
            threadId: waitThreadId,
            ...(envId ? { environmentId: envId } : {}),
          });
          await audit(
            options.config.auditDir,
            {
              tool: waitToolName,
              environmentId: envId,
              threadId: waitThreadId,
              status: waitResult.status,
            },
            now,
          );
          const summary = truncateSummary(waitResult.content, 240);
          await options.speak(`Done on ${envLabel ?? "hub"}: ${summary}`);
          return {
            callId,
            name,
            status: waitResult.ok ? "ok" : waitResult.status,
            output: JSON.stringify({
              launch: result.content,
              wait: waitResult.content,
              summary,
            }),
            rejected: false,
          };
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
