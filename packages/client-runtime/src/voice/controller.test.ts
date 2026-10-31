import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { VoiceController, type VoiceDependencies, type VoiceTransport } from "./controller.ts";

function setup(
  overrides: Partial<VoiceDependencies> = {},
  onSend?: (event: Record<string, unknown>) => void,
) {
  let callbacks: Parameters<VoiceTransport["connect"]>[0] | undefined;
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn();
  const execute = vi.fn(async () => ({ status: "completed" as const, output: "ok" }));
  const end = vi.fn(async () => {});
  const controller = new VoiceController({
    transport: () => ({
      connect: async (input) => {
        callbacks = input;
        await input.exchangeOffer("offer");
      },
      send: (event) => {
        sent.push(event);
        onSend?.(event);
      },
      close,
      setMuted: () => {},
    }),
    start: async () => ({ sessionId: "live-1", sdp: "answer" }),
    end,
    execute,
    confirm: async () => ({ status: "completed", output: "confirmed" }),
    ...overrides,
  });
  return {
    controller,
    sent,
    close,
    execute,
    end,
    event: (event: unknown) => callbacks?.onData(JSON.stringify(event)),
  };
}
const target = {
  environmentId: EnvironmentId.make("local"),
  label: "Test thread",
  threadId: "thread",
};

it("waits for session readiness and preserves overlapping transcript fragments", async () => {
  const { controller, event, close } = setup();
  await controller.start(target);
  expect(controller.getSnapshot().phase).toBe("connecting");
  event({ type: "session.started" });
  event({ type: "session.input_transcript.delta", delta: "I need" });
  event({ type: "session.output_transcript.delta", delta: "Sure" });
  event({ type: "session.input_transcript.delta", delta: " two threads" });
  expect(controller.getSnapshot()).toMatchObject({
    phase: "live",
    userText: "I need two threads",
    assistantText: "Sure",
  });
  await controller.end();
  event({ type: "session.input_transcript.delta", delta: "late" });
  expect(controller.getSnapshot().userText).toBe("I need two threads");
  expect(close).toHaveBeenCalledOnce();
});

it("releases a session created after End without reviving the microphone", async () => {
  let resolve!: (value: { sessionId: string; sdp: string }) => void;
  const creation = new Promise<{ sessionId: string; sdp: string }>((done) => {
    resolve = done;
  });
  const { controller, end, close } = setup({ start: () => creation });
  const connecting = controller.start(target);
  await controller.end();
  resolve({ sessionId: "late-session", sdp: "answer" });
  await connecting;
  expect(controller.getSnapshot().phase).toBe("ended");
  expect(close).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledWith(target.environmentId, "late-session");
});

it("executes a repeated function event once and ignores its result after End", async () => {
  let complete!: (value: { status: "completed"; output: string }) => void;
  const execution = new Promise<{ status: "completed"; output: string }>((done) => {
    complete = done;
  });
  const execute = vi.fn(() => execution);
  const { controller, event, sent } = setup({ execute });
  await controller.start(target);
  event({ type: "session.started" });
  const call = {
    type: "response.event",
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "1",
        name: "t3_thread_send",
        arguments: '{"threadId":"thread","message":"go"}',
      },
    },
  };
  event(call);
  event(call);
  expect(execute).toHaveBeenCalledOnce();
  await controller.end();
  complete({ status: "completed", output: "late result" });
  await execution;
  expect(sent.some((event) => event.type === "response.item.create")).toBe(false);
});

it("commits dictation before returning its final transcript and never executes tools", async () => {
  const { controller, event, sent, execute } = setup();
  await controller.start(target, "dictation");
  event({ type: "session.created" });
  event({ type: "conversation.item.input_audio_transcription.delta", delta: "par" });
  event({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "1", name: "t3_thread_send", arguments: "{}" },
  });
  const finishing = controller.finishDictation();
  expect(controller.getSnapshot().phase).toBe("finishing");
  expect(sent.at(-1)).toEqual({ type: "input_audio_buffer.commit" });
  event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Parsed words.",
  });
  expect(await finishing).toBe("Parsed words.");
  expect(execute).not.toHaveBeenCalled();

  await controller.start(target, "dictation");
  event({ type: "session.created" });
  event({ type: "conversation.item.input_audio_transcription.delta", delta: "discard this" });
  const cancelled = controller.finishDictation();
  await controller.end();
  expect(await cancelled).toBeNull();

  vi.useFakeTimers();
  try {
    await controller.start(target, "dictation");
    event({ type: "session.created" });
    const incomplete = controller.finishDictation();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await incomplete).toBeNull();
    expect(controller.getSnapshot().phase).toBe("error");
  } finally {
    vi.useRealTimers();
  }
});

it("speaks completion after a launched run settles and expires unanswered confirmations", async () => {
  vi.useFakeTimers();
  try {
    const waited = Promise.withResolvers<{ status: "completed"; output: string }>();
    const watching = Promise.withResolvers<void>();
    const announced = Promise.withResolvers<void>();
    const confirm = vi.fn(async () => ({
      status: "completed" as const,
      output: '{"cancelled":true}',
    }));
    const { controller, event, sent } = setup(
      {
        confirm,
        execute: async (_environmentId, input) => {
          if (input.name === "t3_thread_wait") {
            watching.resolve();
            return waited.promise;
          }
          return input.name === "t3_thread_launch"
            ? { status: "completed", output: '{"threadId":"launched","runId":"run-1"}' }
            : { status: "confirmation_required", output: "Confirm this action." };
        },
      },
      (event) => {
        if (event.content === "Thread launched on Test thread: completed.") announced.resolve();
      },
    );
    await controller.start(target);
    event({ type: "session.started" });
    event({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "launch",
        name: "t3_thread_launch",
        arguments: "{}",
      },
    });
    await watching.promise;
    waited.resolve({ status: "completed", output: '{"status":"completed","timedOut":false}' });
    await announced.promise;
    expect(sent).toContainEqual({
      type: "session.commentary.append",
      delegation_id: null,
      content: "Thread launched on Test thread: completed.",
    });
    event({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "guarded",
        name: "t3_project_create",
        arguments: "{}",
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(confirm).toHaveBeenCalledWith(target.environmentId, {
      sessionId: "live-1",
      callId: "guarded",
      accepted: false,
    });
    expect(controller.getSnapshot().confirmation).toBeNull();
    await controller.end();
  } finally {
    vi.useRealTimers();
  }
});
