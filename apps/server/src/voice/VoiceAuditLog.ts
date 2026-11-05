import type { VoiceReportEvent, VoiceStartInput } from "@t3tools/contracts";
import { redactVoiceLogText } from "@t3tools/shared/voice/logRedaction";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

export const VOICE_LOG_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const VOICE_LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const VOICE_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const VOICE_LOG_QUEUE_CAPACITY = 256;
const VOICE_LOG_WRITE_TIMEOUT = "2 seconds";

export type VoiceAuditMode = VoiceStartInput["mode"];
export type VoiceToolStatus = "completed" | "confirmation_required" | "cancelled" | "error";
export type VoiceAuditEvent =
  | { readonly type: "session.start"; readonly mode: VoiceAuditMode; readonly model: string }
  | {
      readonly type: "session.end";
      readonly mode: VoiceAuditMode;
      readonly model: string;
      readonly durationMs: number;
      readonly endReason: string;
    }
  | {
      readonly type: "connect" | "reconnect" | "disconnect";
      readonly mode: VoiceAuditMode;
      readonly attempt: number;
      readonly latencyMs: number;
    }
  | {
      readonly type: "turn.start";
      readonly mode: VoiceAuditMode;
      readonly turnId: string;
      readonly role: "user" | "assistant";
    }
  | {
      readonly type: "turn.end";
      readonly mode: VoiceAuditMode;
      readonly turnId: string;
      readonly role: "user" | "assistant";
      readonly durationMs: number;
      readonly firstAudioMs?: number;
    }
  | {
      readonly type: "transcript";
      readonly mode: VoiceAuditMode;
      readonly role: "user" | "assistant";
      readonly text: string;
    }
  | {
      readonly type: "tool.call";
      readonly mode: VoiceAuditMode;
      readonly callId: string;
      readonly name: string;
      readonly argsSummary: Readonly<Record<string, string | number>>;
      readonly status: VoiceToolStatus;
      readonly durationMs: number;
      readonly resultChars: number;
    }
  | {
      readonly type: "confirm";
      readonly mode: VoiceAuditMode;
      readonly callId: string;
      readonly accepted: boolean;
    }
  | {
      readonly type: "error";
      readonly mode: VoiceAuditMode;
      readonly where: string;
      readonly reason: string;
      readonly providerType?: string;
      readonly message: string;
      readonly latencyMs?: number;
    }
  | { readonly type: "truncated"; readonly mode: VoiceAuditMode };

export class VoiceAuditLog extends Context.Service<
  VoiceAuditLog,
  {
    readonly append: (sessionId: string, event: VoiceAuditEvent) => Effect.Effect<void>;
    readonly retain: () => Effect.Effect<void>;
    readonly close: (sessionId: string) => Effect.Effect<void>;
    /** Waits until queued writes finish. Session code does not call this. */
    readonly flush: Effect.Effect<void>;
  }
>()("t3/voice/VoiceAuditLog") {}

type LogJob =
  | { readonly _tag: "event"; readonly sessionId: string; readonly event: VoiceAuditEvent }
  | { readonly _tag: "close"; readonly sessionId: string };

const encoder = new TextEncoder();
const fileSessionId = (sessionId: string) => {
  const safe = redactVoiceLogText(sessionId, 80)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe.length > 0 ? safe : "session";
};

const eventFields = (event: VoiceAuditEvent): Record<string, unknown> => {
  switch (event.type) {
    case "session.start":
      return { model: redactVoiceLogText(event.model, 200) };
    case "session.end":
      return {
        model: redactVoiceLogText(event.model, 200),
        durationMs: event.durationMs,
        endReason: redactVoiceLogText(event.endReason, 200),
      };
    case "connect":
    case "reconnect":
    case "disconnect":
      return { attempt: event.attempt, latencyMs: event.latencyMs };
    case "turn.start":
      return { turnId: redactVoiceLogText(event.turnId, 200), role: event.role };
    case "turn.end":
      return {
        turnId: redactVoiceLogText(event.turnId, 200),
        role: event.role,
        durationMs: event.durationMs,
        ...(event.firstAudioMs === undefined ? {} : { firstAudioMs: event.firstAudioMs }),
      };
    case "transcript":
      return { role: event.role, text: redactVoiceLogText(event.text, 2000) };
    case "tool.call":
      return {
        callId: redactVoiceLogText(event.callId, 200),
        name: redactVoiceLogText(event.name, 200),
        argsSummary: Object.fromEntries(
          Object.entries(event.argsSummary).flatMap(([key, value]) =>
            /sdp|audio|authorization|api[-_]?key|token|secret|password|bearer|ephemeral|cookie/i.test(
              key,
            )
              ? []
              : [[key, typeof value === "string" ? redactVoiceLogText(value, 200) : value]],
          ),
        ),
        status: event.status,
        durationMs: event.durationMs,
        resultChars: event.resultChars,
      };
    case "confirm":
      return { callId: redactVoiceLogText(event.callId, 200), accepted: event.accepted };
    case "error":
      return {
        where: redactVoiceLogText(event.where, 200),
        reason: redactVoiceLogText(event.reason, 200),
        ...(event.providerType === undefined
          ? {}
          : { providerType: redactVoiceLogText(event.providerType, 200) }),
        message: redactVoiceLogText(event.message, 200),
        ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
      };
    case "truncated":
      return {};
  }
};

/** Client reports are already schema-bounded; map them onto the audit line. */
export const auditEventFromReport = (
  mode: VoiceAuditMode,
  event: VoiceReportEvent,
): VoiceAuditEvent => {
  switch (event.type) {
    case "connect":
    case "reconnect":
    case "disconnect":
      return { type: event.type, mode, attempt: event.attempt, latencyMs: event.latencyMs };
    case "turn.start":
      return { type: "turn.start", mode, turnId: event.turnId, role: event.role };
    case "turn.end":
      return {
        type: "turn.end",
        mode,
        turnId: event.turnId,
        role: event.role,
        durationMs: event.durationMs,
        ...(event.firstAudioMs === undefined ? {} : { firstAudioMs: event.firstAudioMs }),
      };
    case "transcript":
      return { type: "transcript", mode, role: event.role, text: event.text };
    case "error":
      return {
        type: "error",
        mode,
        where: event.where,
        reason: event.reason,
        ...(event.providerType === undefined ? {} : { providerType: event.providerType }),
        message: event.message,
      };
  }
};

interface OpenFile {
  path: string;
  mode: VoiceAuditMode;
  seq: number;
  bytes: number;
  truncated: boolean;
  sized: boolean;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const directory = config.voiceLogsDir;
  const open = new Map<string, OpenFile>();
  let directoryReady = false;
  const jobs = yield* Queue.dropping<LogJob>(VOICE_LOG_QUEUE_CAPACITY);
  const outstanding = yield* Ref.make(0);
  const dropped = yield* Ref.make(0);
  const waiters = yield* Ref.make<Array<Deferred.Deferred<void>>>([]);

  const prepareDirectory = Effect.gen(function* () {
    if (directoryReady) return;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.chmod(directory, 0o700).pipe(Effect.ignore);
    directoryReady = true;
  });

  const release = Effect.fnUntraced(function* () {
    const left = yield* Ref.updateAndGet(outstanding, (count) => count - 1);
    if (left > 0) return;
    const pending = yield* Ref.getAndSet(waiters, []);
    for (const waiter of pending) yield* Deferred.succeed(waiter, undefined);
  });
  const enqueue = Effect.fnUntraced(function* (job: LogJob) {
    yield* Ref.update(outstanding, (count) => count + 1);
    const accepted = yield* Queue.offer(jobs, job);
    if (accepted) return;
    const count = yield* Ref.updateAndGet(dropped, (value) => value + 1);
    yield* Effect.logDebug("Voice audit log dropped an event because the queue is full.", {
      dropped: count,
    });
    yield* release();
  });
  // Disk writes run here, off the session fiber. Per-line spans would flood the trace.
  const write = Effect.fnUntraced(function* (sessionId: string, event: VoiceAuditEvent) {
    if (event.type === "transcript") {
      const enabled = yield* settings.getSettings.pipe(
        Effect.map((value) => value.voiceLogTranscripts),
        Effect.orElseSucceed(() => true),
      );
      if (!enabled) return;
    }
    yield* prepareDirectory;
    const now = yield* DateTime.now;
    const day = DateTime.formatIsoDateUtc(now).replaceAll("-", "");
    const filePath = path.join(directory, `${day}-${fileSessionId(sessionId)}.jsonl`);
    let state = open.get(filePath);
    if (state === undefined) {
      state = {
        path: filePath,
        mode: event.mode,
        seq: 1,
        bytes: 0,
        truncated: false,
        sized: false,
      };
      open.set(filePath, state);
    }
    if (!state.sized) {
      const info = yield* fs.stat(filePath).pipe(Effect.option);
      if (Option.isSome(info)) state.bytes = ByteSize.toNumberUnsafe(info.value.size);
      state.sized = true;
      yield* fs.chmod(filePath, 0o600).pipe(Effect.ignore);
    }
    if (state.truncated || state.bytes >= VOICE_LOG_MAX_FILE_BYTES) {
      if (state.truncated) return;
      state.truncated = true;
      yield* appendLine(state, sessionId, { type: "truncated", mode: state.mode }, now);
      return;
    }
    const line = render(sessionId, event, state.seq, now);
    if (state.bytes + encoder.encode(line).byteLength > VOICE_LOG_MAX_FILE_BYTES) {
      state.truncated = true;
      yield* appendLine(state, sessionId, { type: "truncated", mode: state.mode }, now);
      return;
    }
    yield* commit(state, line);
  });

  const render = (sessionId: string, event: VoiceAuditEvent, seq: number, now: DateTime.Utc) =>
    `${JSON.stringify({
      v: 1,
      ts: DateTime.formatIso(now),
      sessionId: redactVoiceLogText(sessionId, 128),
      mode: event.mode,
      seq,
      type: event.type,
      ...eventFields(event),
    })}\n`;

  const commit = Effect.fn("VoiceAuditLog.commit")(function* (state: OpenFile, line: string) {
    const creating = state.bytes === 0;
    yield* fs.writeFileString(state.path, line, { flag: "a", mode: 0o600 });
    if (creating) yield* fs.chmod(state.path, 0o600).pipe(Effect.ignore);
    state.bytes += encoder.encode(line).byteLength;
    state.seq += 1;
  });

  const appendLine = (
    state: OpenFile,
    sessionId: string,
    event: VoiceAuditEvent,
    now: DateTime.Utc,
  ) => commit(state, render(sessionId, event, state.seq, now));

  const sweep = Effect.fn("VoiceAuditLog.sweep")(function* () {
    yield* prepareDirectory;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed((): string[] => []));
    const files: { path: string; bytes: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(directory, name);
      const info = yield* fs.stat(filePath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const mtimeMs = Option.match(info.value.mtime, {
        onNone: () => nowMs,
        onSome: (value) => value.getTime(),
      });
      files.push({
        path: filePath,
        bytes: ByteSize.toNumberUnsafe(info.value.size),
        mtimeMs,
      });
    }
    const kept: typeof files = [];
    for (const file of files) {
      if (nowMs - file.mtimeMs > VOICE_LOG_MAX_AGE_MS) {
        yield* fs.remove(file.path).pipe(Effect.ignore);
        open.delete(file.path);
      } else {
        kept.push(file);
      }
    }
    kept.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let total = kept.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of kept) {
      if (total <= VOICE_LOG_MAX_TOTAL_BYTES) break;
      yield* fs.remove(file.path).pipe(Effect.ignore);
      open.delete(file.path);
      total -= file.bytes;
    }
  });
  const runJob = Effect.fnUntraced(function* (job: LogJob) {
    if (job._tag === "close") {
      const suffix = `-${fileSessionId(job.sessionId)}.jsonl`;
      const closedPaths: string[] = [];
      for (const filePath of open.keys()) {
        if (filePath.endsWith(suffix)) closedPaths.push(filePath);
      }
      for (const filePath of closedPaths) open.delete(filePath);
      return;
    }
    yield* write(job.sessionId, job.event).pipe(
      Effect.timeout(VOICE_LOG_WRITE_TIMEOUT),
      Effect.ignoreCause({ log: true }),
    );
  });
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const job = yield* Queue.take(jobs);
        yield* runJob(job).pipe(Effect.ignoreCause({ log: true }));
        yield* release();
      }),
    ),
  );
  const append = Effect.fn("VoiceAuditLog.append")(function* (
    sessionId: string,
    event: VoiceAuditEvent,
  ) {
    yield* enqueue({ _tag: "event", sessionId, event });
  });
  const close = Effect.fn("VoiceAuditLog.close")(function* (sessionId: string) {
    yield* enqueue({ _tag: "close", sessionId });
  });
  const retain = Effect.fn("VoiceAuditLog.retain")(function* () {
    yield* sweep().pipe(Effect.ignoreCause({ log: true }));
  });
  const flush = Effect.fn("VoiceAuditLog.flush")(function* () {
    if ((yield* Ref.get(outstanding)) === 0) return;
    const gate = yield* Deferred.make<void>();
    yield* Ref.update(waiters, (pending) => [...pending, gate]);
    if ((yield* Ref.get(outstanding)) === 0) yield* Deferred.succeed(gate, undefined);
    yield* Deferred.await(gate);
  });
  return VoiceAuditLog.of({
    append,
    retain,
    close,
    flush: Effect.suspend(() => flush()),
  });
});

export const layer = Layer.effect(VoiceAuditLog, make);
