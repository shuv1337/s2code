/**
 * GPT-Live session client (WebSocket) with Responses delegation.
 * Tool calls from nested response.output_item.done → ToolBridge →
 * response.item.create(function_call_output) + response.create.
 *
 * Shape follows OpenAI GPT-Live docs (model gpt-live-1, delegation.responses).
 * Audio I/O is optional; text-dry-run drives the same tool path without a socket.
 */
import WebSocket from "ws";

import type { VoiceConfig } from "./config.ts";
import { buildLiveFunctionTools, LIVE_SYSTEM_INSTRUCTIONS } from "./liveTools.ts";
import type { ToolBridge, ToolBridgeResult } from "./toolBridge.ts";

export interface LiveSessionHandlers {
  readonly onSpeakText?: (text: string) => void;
  readonly onEvent?: (event: Record<string, unknown>) => void;
  readonly onToolResult?: (result: ToolBridgeResult) => void;
}

export interface LiveSession {
  readonly close: () => void;
  readonly send: (event: Record<string, unknown>) => void;
  readonly waitOpen: () => Promise<void>;
}

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
};

/**
 * Handle one nested Responses output item. Returns true if it was a function_call
 * we submitted results for (caller should response.create).
 */
export const handleLiveOutputItem = async (
  item: Record<string, unknown>,
  bridge: ToolBridge,
  send: (event: Record<string, unknown>) => void,
  handlers?: LiveSessionHandlers,
): Promise<boolean> => {
  if (item.type !== "function_call") return false;
  const name = typeof item.name === "string" ? item.name : "";
  const callId = typeof item.call_id === "string" ? item.call_id : undefined;
  const args = parseArgs(item.arguments);
  const result = await bridge.handleFunctionCall({
    name,
    arguments: args,
    callId,
  });
  handlers?.onToolResult?.(result);
  send({
    type: "response.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: result.output,
    },
  });
  return true;
};

export const buildSessionCreatePayload = (config: VoiceConfig) => ({
  type: "session.create",
  session: {
    model: config.liveModel,
    instructions: LIVE_SYSTEM_INSTRUCTIONS,
    delegation: {
      type: "responses",
      responses: {
        model: config.backendModel,
        instructions: LIVE_SYSTEM_INSTRUCTIONS,
        tools: buildLiveFunctionTools(),
        tool_choice: "auto",
        parallel_tool_calls: false,
      },
    },
  },
});

export const connectLiveSession = (
  config: VoiceConfig,
  bridge: ToolBridge,
  handlers: LiveSessionHandlers = {},
): LiveSession => {
  if (!config.openaiApiKey) {
    throw new Error("OPENAI_API_KEY required for live mode");
  }

  const ws = new WebSocket(config.liveWsUrl, {
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "OpenAI-Beta": "live=v1",
    },
  });

  let openResolve: (() => void) | undefined;
  let openReject: ((err: Error) => void) | undefined;
  const openPromise = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });

  const send = (event: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  };

  ws.on("open", () => {
    send(buildSessionCreatePayload(config));
    openResolve?.();
  });

  ws.on("error", (err) => {
    openReject?.(err instanceof Error ? err : new Error(String(err)));
  });

  ws.on("message", (data) => {
    void (async () => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      handlers.onEvent?.(event);

      // Nested Responses events under response.event envelope.
      if (event.type === "response.event" && event.event && typeof event.event === "object") {
        const nested = event.event as Record<string, unknown>;
        if (nested.type === "response.output_item.done" && nested.item) {
          const item = nested.item as Record<string, unknown>;
          const handled = await handleLiveOutputItem(item, bridge, send, handlers);
          if (handled) {
            send({ type: "response.create" });
          }
        }
      }

      if (event.type === "session.output_transcript.delta" && typeof event.delta === "string") {
        handlers.onSpeakText?.(event.delta);
      }
    })();
  });

  return {
    close: () => ws.close(),
    send,
    waitOpen: () => openPromise,
  };
};

/**
 * Text-mode dry run: feed synthetic function_call items through the same
 * handleLiveOutputItem path used by a live session (no WebSocket / no key).
 */
export const runTextDryRun = async (
  bridge: ToolBridge,
  calls: ReadonlyArray<{
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
    readonly callId?: string;
  }>,
): Promise<ToolBridgeResult[]> => {
  const results: ToolBridgeResult[] = [];
  const sent: Record<string, unknown>[] = [];
  const send = (event: Record<string, unknown>) => {
    sent.push(event);
  };

  for (const [i, call] of calls.entries()) {
    await handleLiveOutputItem(
      {
        type: "function_call",
        name: call.name,
        call_id: call.callId ?? `dry_${i}`,
        arguments: JSON.stringify(call.arguments ?? {}),
      },
      bridge,
      send,
      {
        onToolResult: (r) => {
          results.push(r);
        },
      },
    );
    send({ type: "response.create" });
  }

  return results;
};
