import type {
  EnvironmentId,
  VoiceStartInput,
  VoiceStartResult,
  VoiceToolInput,
  VoiceToolResult,
} from "@t3tools/contracts";
import { parseSpokenAnswer } from "@t3tools/shared/voice/confirmation";
import { isLongRunningVoiceTool, isSideEffectVoiceTool } from "@t3tools/shared/voice/allowlist";
import { toolPayload } from "@t3tools/shared/voice/resultSummary";

export interface VoiceTransport {
  connect(input: {
    exchangeOffer: (sdp: string) => Promise<string>;
    onData: (data: string) => void;
    onConnectionStateChange: (state: string) => void;
    onMicrophoneEnded: () => void;
    playRemoteAudio: boolean;
  }): Promise<void>;
  send(event: Record<string, unknown>): void;
  setMuted(muted: boolean): void;
  close(): void;
}
export interface VoiceTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly environmentLabel?: string;
  readonly threadId?: string;
  readonly projectId?: string;
}
export interface VoiceState {
  readonly phase: "idle" | "connecting" | "live" | "finishing" | "ended" | "error";
  readonly mode: "call" | "dictation";
  readonly target: VoiceTarget | null;
  readonly muted: boolean;
  readonly userText: string;
  readonly assistantText: string;
  readonly error: string | null;
  readonly tools: readonly {
    callId: string;
    name: string;
    status: "running" | "completed" | "failed" | "confirmation_required";
    output: string;
  }[];
  readonly confirmation: { callId: string; prompt: string } | null;
}
export interface VoiceDependencies {
  readonly transport: () => VoiceTransport;
  readonly start: (
    environmentId: EnvironmentId,
    input: VoiceStartInput,
  ) => Promise<VoiceStartResult>;
  readonly end: (environmentId: EnvironmentId, sessionId: string) => Promise<void>;
  readonly execute: (
    environmentId: EnvironmentId,
    input: VoiceToolInput,
  ) => Promise<VoiceToolResult>;
  readonly confirm: (
    environmentId: EnvironmentId,
    input: { sessionId: string; callId: string; accepted: boolean },
  ) => Promise<VoiceToolResult>;
}
const initial: VoiceState = {
  phase: "idle",
  mode: "call",
  target: null,
  muted: false,
  userText: "",
  assistantText: "",
  error: null,
  tools: [],
  confirmation: null,
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export class VoiceController {
  #state: VoiceState = initial;
  #listeners = new Set<() => void>();
  #transport: VoiceTransport | null = null;
  #sessionId: string | null = null;
  #epoch = 0;
  #seen = new Set<string>();
  #confirmText = "";
  #dictationDone: (() => void) | null = null;
  #startupTimer: ReturnType<typeof setTimeout> | undefined;
  #confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  readonly dependencies: VoiceDependencies;
  constructor(dependencies: VoiceDependencies) {
    this.dependencies = dependencies;
  }
  readonly getSnapshot = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #update(patch: Partial<VoiceState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  selectTarget(target: VoiceTarget) {
    if (!["connecting", "live", "finishing"].includes(this.#state.phase))
      this.#update({ target, mode: "call" });
  }
  async start(target: VoiceTarget, mode: "call" | "dictation" = "call") {
    if (["connecting", "live", "finishing"].includes(this.#state.phase)) return;
    const epoch = ++this.#epoch;
    const transport = this.dependencies.transport();
    this.#transport = transport;
    this.#seen.clear();
    this.#confirmText = "";
    this.#update({ ...initial, phase: "connecting", target, mode });
    // @effect-diagnostics-next-line globalTimers:off - this imperative media controller also runs outside an Effect runtime
    this.#startupTimer = setTimeout(() => {
      if (epoch === this.#epoch)
        void this.#fail("Voice did not become ready. Check your connection and retry.");
    }, 45_000);
    try {
      await transport.connect({
        exchangeOffer: async (sdp) => {
          const result = await this.dependencies.start(target.environmentId, { sdp, mode });
          if (epoch !== this.#epoch) {
            await this.dependencies.end(target.environmentId, result.sessionId);
            return result.sdp;
          }
          this.#sessionId = result.sessionId;
          return result.sdp;
        },
        onData: (data) => {
          if (epoch === this.#epoch) this.#receive(data);
        },
        onConnectionStateChange: (state) => {
          if (
            epoch === this.#epoch &&
            (state === "failed" || state === "disconnected" || state === "closed")
          )
            void this.#fail("Voice connection lost. Start a new call to reconnect.");
        },
        onMicrophoneEnded: () => {
          if (epoch === this.#epoch)
            void this.#fail("The microphone disconnected. Reconnect it and try again.");
        },
        playRemoteAudio: mode === "call",
      });
    } catch (error) {
      if (epoch === this.#epoch)
        await this.#fail(
          error instanceof Error ? error.message : "Could not start voice. Try again.",
        );
    }
  }
  async #fail(message: string) {
    const closing = this.end();
    this.#update({ phase: "error", error: message });
    await closing;
  }
  setMuted(muted: boolean) {
    this.#transport?.setMuted(muted);
    if (this.#state.mode === "call")
      this.#transport?.send({
        type: muted ? "session.input_audio.mute" : "session.input_audio.unmute",
      });
    this.#update({ muted });
  }
  async end() {
    ++this.#epoch;
    clearTimeout(this.#startupTimer);
    clearTimeout(this.#confirmationTimer);
    this.#dictationDone?.();
    this.#dictationDone = null;
    const transport = this.#transport;
    const sessionId = this.#sessionId;
    const target = this.#state.target;
    this.#transport = null;
    this.#sessionId = null;
    transport?.setMuted(true);
    if (this.#state.mode === "call") transport?.send({ type: "session.close" });
    transport?.close();
    this.#update({ phase: "ended", muted: false, confirmation: null });
    if (sessionId && target)
      await this.dependencies.end(target.environmentId, sessionId).catch(() => undefined);
  }
  async finishDictation(): Promise<string | null> {
    if (this.#state.mode !== "dictation" || this.#state.phase !== "live") return null;
    const epoch = this.#epoch;
    this.#update({ phase: "finishing" });
    this.#transport?.setMuted(true);
    const finalized = await new Promise<boolean>((resolve) => {
      // @effect-diagnostics-next-line globalTimers:off - bounds the native/browser data-channel final transcript wait
      const timer = setTimeout(() => resolve(false), 5000);
      this.#dictationDone = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.#transport?.send({ type: "input_audio_buffer.commit" });
    });
    if (epoch !== this.#epoch) return null;
    if (!finalized) {
      await this.#fail(
        "Transcription did not finish. Your draft is unchanged; copy any captured words below.",
      );
      return null;
    }
    const text = this.#state.userText;
    await this.end();
    return text;
  }
  #receive(data: string) {
    let event: Record<string, unknown> | undefined;
    try {
      event = object(JSON.parse(data));
    } catch {
      return;
    }
    if (!event) return;
    if (
      event.type === "session.started" ||
      (this.#state.mode === "dictation" && event.type === "session.created")
    ) {
      clearTimeout(this.#startupTimer);
      this.#update({ phase: "live" });
      const target = this.#state.target;
      if (target && this.#state.mode === "call")
        this.#transport?.send({
          type: "session.thinking.append",
          delegation_id: null,
          content: `Selected environment: ${target.environmentLabel ?? target.label}. Current project: ${target.projectId ?? "none"}. Current thread: ${target.threadId ?? "none"}.`,
        });
    }
    if (event.type === "session.closed") {
      void this.end();
      return;
    }
    if (event.type === "error" || event.type === "client.playback-error") {
      void this.#fail(
        event.type === "client.playback-error"
          ? "Speaker playback was blocked. Allow audio playback and start again."
          : "The voice provider reported an error. Start a new session.",
      );
      return;
    }
    if (event.type === "session.input_transcript.delta" && typeof event.delta === "string") {
      this.#update({ userText: (this.#state.userText + event.delta).slice(-24000) });
      if (this.#state.confirmation) {
        this.#confirmText += event.delta;
        const answer = parseSpokenAnswer(this.#confirmText);
        if (answer) void this.confirm(answer === "yes");
      }
    }
    if (event.type === "session.output_transcript.delta" && typeof event.delta === "string")
      this.#update({ assistantText: (this.#state.assistantText + event.delta).slice(-24000) });
    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      typeof event.delta === "string"
    )
      this.#update({ userText: this.#state.userText + event.delta });
    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      typeof event.transcript === "string"
    ) {
      this.#update({ userText: event.transcript });
      this.#dictationDone?.();
    }
    const nested = event.type === "response.event" ? object(event.event) : event;
    const item = nested?.type === "response.output_item.done" ? object(nested.item) : undefined;
    if (
      item?.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      let args: Record<string, unknown> | undefined;
      try {
        args =
          typeof item.arguments === "string"
            ? object(JSON.parse(item.arguments))
            : object(item.arguments);
      } catch {
        args = undefined;
      }
      if (args) void this.#tool(item.call_id, item.name, args);
    }
  }
  #toolState(callId: string, patch: Partial<VoiceState["tools"][number]>) {
    this.#update({
      tools: this.#state.tools.map((tool) =>
        tool.callId === callId ? { ...tool, ...patch } : tool,
      ),
    });
  }
  #output(callId: string, result: VoiceToolResult) {
    this.#toolState(callId, { status: result.status, output: result.output });
    if (result.status === "confirmation_required") {
      this.#confirmText = "";
      this.#update({ confirmation: { callId, prompt: result.output } });
      clearTimeout(this.#confirmationTimer);
      // @effect-diagnostics-next-line globalTimers:off - spoken confirmation expires in the imperative media controller
      this.#confirmationTimer = setTimeout(() => void this.confirm(false), 20_000);
      this.#transport?.send({
        type: "session.commentary.append",
        delegation_id: null,
        content: result.output,
      });
    } else {
      this.#transport?.send({
        type: "response.item.create",
        item: { type: "function_call_output", call_id: callId, output: result.output },
      });
      this.#transport?.send({ type: "response.create" });
    }
  }
  async #tool(callId: string, name: string, args: Record<string, unknown>) {
    if (
      this.#seen.has(callId) ||
      !this.#sessionId ||
      !this.#state.target ||
      this.#state.mode !== "call"
    )
      return;
    this.#seen.add(callId);
    const epoch = this.#epoch;
    if (isSideEffectVoiceTool(name, args))
      this.#transport?.send({
        type: "session.commentary.append",
        delegation_id: null,
        content: `On ${typeof args.environmentId === "string" ? args.environmentId : (this.#state.target.environmentLabel ?? this.#state.target.label)}.`,
      });
    this.#update({
      tools: [...this.#state.tools.slice(-49), { callId, name, status: "running", output: "" }],
    });
    try {
      const result = await this.dependencies.execute(this.#state.target.environmentId, {
        sessionId: this.#sessionId,
        callId,
        name,
        arguments: args,
      });
      if (epoch === this.#epoch) {
        this.#output(callId, result);
        if (result.status === "completed" && isLongRunningVoiceTool(name))
          void this.#watch(callId, args, result.output, epoch);
      }
    } catch {
      if (epoch === this.#epoch) {
        this.#output(callId, {
          status: "completed",
          output: '{"error":"Action failed or permission was denied."}',
        });
        this.#toolState(callId, { status: "failed" });
      }
    }
  }
  async #watch(callId: string, args: Record<string, unknown>, output: string, epoch: number) {
    const target = this.#state.target;
    const sessionId = this.#sessionId;
    if (!target || !sessionId) return;
    try {
      const started = toolPayload(JSON.parse(output));
      const threadId = started?.threadId;
      if (typeof threadId !== "string") return;
      for (let attempt = 0; attempt < 12 && epoch === this.#epoch; attempt++) {
        const result = await this.dependencies.execute(target.environmentId, {
          sessionId,
          callId: `${callId}:wait:${attempt}`,
          name: "t3_thread_wait",
          arguments: {
            threadId,
            timeoutMs: 15_000,
            ...(typeof started?.runId === "string" ? { runId: started.runId } : {}),
            ...(typeof args.environmentId === "string"
              ? { environmentId: args.environmentId }
              : {}),
          },
        });
        if (epoch !== this.#epoch) return;
        const settled = toolPayload(JSON.parse(result.output));
        if (settled?.timedOut === false) {
          this.#transport?.send({
            type: "session.commentary.append",
            delegation_id: null,
            content: `Thread ${threadId} on ${target.environmentLabel ?? target.label}: ${String(settled.status)}.`,
          });
          return;
        }
        if (settled?.timedOut !== true) return;
      }
    } catch {
      if (epoch === this.#epoch)
        this.#transport?.send({
          type: "session.commentary.append",
          delegation_id: null,
          content: "Could not retrieve the agent's final status. Check the thread for its result.",
        });
    }
  }
  async confirm(accepted: boolean) {
    const pending = this.#state.confirmation;
    if (!pending || !this.#sessionId || !this.#state.target) return;
    const epoch = this.#epoch;
    clearTimeout(this.#confirmationTimer);
    this.#update({ confirmation: null });
    try {
      const result = await this.dependencies.confirm(this.#state.target.environmentId, {
        sessionId: this.#sessionId,
        callId: pending.callId,
        accepted,
      });
      if (epoch === this.#epoch) this.#output(pending.callId, result);
    } catch {
      if (epoch === this.#epoch) {
        this.#output(pending.callId, {
          status: "completed",
          output: '{"error":"Could not confirm this action."}',
        });
        this.#toolState(pending.callId, {
          status: "failed",
          output: "Could not confirm this action.",
        });
      }
    }
  }
}
