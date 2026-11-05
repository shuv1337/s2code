import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, VoiceError, type VoiceStartInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as McpSchema from "effect/ai/McpSchema";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpToolCaller from "../mcp/McpToolCaller.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceAuditLog from "./VoiceAuditLog.ts";
import * as VoiceSession from "./VoiceSession.ts";
import * as VoiceProvider from "./VoiceProvider.ts";
import * as VoiceTools from "./VoiceTools.ts";

const silentAudit = Layer.succeed(VoiceAuditLog.VoiceAuditLog, {
  append: () => Effect.void,
  retain: () => Effect.void,
});

it.effect("binds calls to their owner, deduplicates actions, and refuses tools after End", () =>
  Effect.gen(function* () {
    let count = 0;
    const layer = VoiceSession.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(VoiceProvider.VoiceProvider, {
            status: Effect.succeed({ configured: true }),
            configure: () => Effect.void,
            start: () => Effect.succeed({ sessionId: "live-1", sdp: "answer" }),
            end: () => Effect.void,
          }),
          Layer.succeed(VoiceTools.VoiceTools, {
            execute: () =>
              Effect.sync(() => {
                count++;
                return JSON.stringify({ ok: true });
              }),
          }),
          silentAudit,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const voice = yield* VoiceSession.VoiceSession;
      const owner = {
        sessionId: "owner",
        scopes: ["orchestration:operate", "orchestration:read"],
      } as const;
      const input: VoiceStartInput = { sdp: "offer", mode: "call" };
      const session = yield* voice.start(owner, input);
      yield* voice.start({ ...owner, scopes: [] }, input).pipe(Effect.flip);
      const call = {
        sessionId: session.sessionId,
        callId: "call-1",
        name: "t3_thread_send",
        arguments: { threadId: "thread", message: "hello" },
      };
      const refused = yield* voice
        .execute({ ...owner, sessionId: "other" }, call)
        .pipe(Effect.flip);
      assert.instanceOf(refused, VoiceError);
      assert.strictEqual(count, 0);
      const results = yield* Effect.all([voice.execute(owner, call), voice.execute(owner, call)], {
        concurrency: "unbounded",
      });
      assert.deepEqual(results[0], results[1]);
      assert.strictEqual(count, 1);
      yield* voice
        .execute(owner, { ...call, callId: "blocked", name: "t3_project_delete" })
        .pipe(Effect.flip);
      const guarded = {
        ...call,
        callId: "guarded",
        arguments: { ...call.arguments, mode: "restart" },
      };
      assert.strictEqual((yield* voice.execute(owner, guarded)).status, "confirmation_required");
      assert.strictEqual(count, 1);
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "guarded",
        accepted: false,
      });
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "guarded",
        accepted: true,
      });
      assert.strictEqual(count, 1);
      yield* voice.execute(owner, { ...guarded, callId: "approved" });
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "approved",
        accepted: true,
      });
      yield* voice.confirm(owner, {
        sessionId: session.sessionId,
        callId: "approved",
        accepted: true,
      });
      assert.strictEqual(count, 2);
      yield* voice.end(owner, session.sessionId);
      yield* voice.execute(owner, { ...call, callId: "call-2" }).pipe(Effect.flip);
      assert.strictEqual(count, 2);
      yield* voice.start(owner, { ...input, mode: "dictation" });
      yield* voice.execute(owner, call).pipe(Effect.flip);
      assert.strictEqual(count, 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("ends provider sessions when the connection scope closes", () =>
  Effect.gen(function* () {
    const ended: string[] = [];
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      VoiceSession.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(VoiceProvider.VoiceProvider, {
              status: Effect.succeed({ configured: true }),
              configure: () => Effect.void,
              start: () => Effect.succeed({ sessionId: "live-1", sdp: "answer" }),
              end: (sessionId) =>
                Effect.sync(() => {
                  ended.push(sessionId);
                }),
            }),
            Layer.succeed(VoiceTools.VoiceTools, {
              execute: () => Effect.succeed("{}"),
            }),
            silentAudit,
          ),
        ),
      ),
      scope,
    );
    const voice = Context.get(context, VoiceSession.VoiceSession);
    const owner = {
      sessionId: "owner",
      scopes: ["orchestration:operate", "orchestration:read"],
    } as const;
    const session = yield* voice.start(owner, { sdp: "offer", mode: "call" });
    assert.deepEqual(ended, []);
    yield* Scope.close(scope, Exit.void);
    assert.deepEqual(ended, [session.sessionId]);
    const refused = yield* voice.end(owner, session.sessionId).pipe(Effect.flip);
    assert.strictEqual(refused.reason, "session_closed");
  }),
);

const owner = {
  sessionId: "owner",
  scopes: ["orchestration:operate", "orchestration:read"],
} as const;
const offer = "v=0\r\na=fingerprint:SECRETSDP\r\n";
const secret = "sk-abcdefghijklmnopqrstuvwxyz";
const bearer = "Bearer supersecrettokenvalue";

const auditedLayer = <E, R>(sessionId: string, tools: Layer.Layer<VoiceTools.VoiceTools, E, R>) =>
  VoiceSession.layer.pipe(
    Layer.provide(tools),
    Layer.provide(
      Layer.succeed(VoiceProvider.VoiceProvider, {
        status: Effect.succeed({ configured: true }),
        configure: () => Effect.void,
        start: () => Effect.succeed({ sessionId, sdp: offer }),
        end: () => Effect.void,
      }),
    ),
    Layer.provide(VoiceAuditLog.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-log-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(TestClock.layer()),
  );

const readVoiceLog = Effect.fn("readVoiceLog")(function* (sessionId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const names = (yield* fs.readDirectory(config.voiceLogsDir)).filter((name) =>
    name.endsWith(`-${sessionId}.jsonl`),
  );
  assert.strictEqual(names.length, 1);
  const file = path.join(config.voiceLogsDir, names[0]!);
  const text = yield* fs.readFileString(file);
  const lines = text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { seq: number; type: string; [key: string]: unknown });
  return { config, file, text, lines };
});

it.effect("writes redacted jsonl and keeps going when the log cannot be written", () =>
  Effect.gen(function* () {
    const layer = auditedLayer(
      "live-1",
      Layer.succeed(VoiceTools.VoiceTools, {
        execute: () =>
          Effect.succeed(`{"apiKey":"${secret}","audio":"AUDIO_PAYLOAD_SECRET","sdp":"${offer}"}`),
      }),
    );
    yield* Effect.gen(function* () {
      const voice = yield* VoiceSession.VoiceSession;
      const fs = yield* FileSystem.FileSystem;
      const session = yield* voice.start(owner, { sdp: offer, mode: "call" });
      yield* voice.execute(owner, {
        sessionId: session.sessionId,
        callId: "call-1",
        name: "t3_thread_send",
        arguments: {
          threadId: `thread ${secret}`,
          environmentId: "env-1",
          projectId: "proj-1",
          message: `hello ${bearer} ${secret}`,
          sdp: offer,
          audio: "AUDIO_PAYLOAD_SECRET",
          apiKey: secret,
        },
      });
      yield* voice.report(owner, {
        sessionId: session.sessionId,
        mode: "call",
        events: [
          {
            type: "transcript",
            role: "user",
            text: `note ${secret} ${bearer}`,
          },
        ],
      });
      yield* voice.end(owner, session.sessionId);
      const { config, file, text, lines } = yield* readVoiceLog("live-1");
      assert.deepEqual(
        lines.map((line) => line.seq),
        lines.map((_, index) => index + 1),
      );
      for (const line of lines) {
        assert.strictEqual(line.v, 1);
        assert.strictEqual(line.sessionId, "live-1");
        assert.strictEqual(line.mode, "call");
        assert.strictEqual(typeof line.ts, "string");
      }
      assert.deepEqual(
        lines.map((line) => line.type),
        ["session.start", "tool.call", "transcript", "session.end"],
      );
      const call = lines[1] as unknown as {
        argsSummary: Record<string, unknown>;
        resultChars: number;
        status: string;
      };
      assert.strictEqual(call.status, "completed");
      assert.strictEqual(call.argsSummary.environmentId, "env-1");
      assert.strictEqual(call.argsSummary.projectId, "proj-1");
      assert.strictEqual(typeof call.argsSummary.message, "number");
      assert.strictEqual(call.argsSummary.threadId, "thread [redacted]");
      assert.strictEqual(call.argsSummary.sdp, undefined);
      assert.strictEqual(call.argsSummary.audio, undefined);
      assert.strictEqual(call.argsSummary.apiKey, undefined);
      assert.isAbove(call.resultChars, 0);
      assert.isFalse(text.includes(secret));
      assert.isFalse(text.includes("Bearer"));
      assert.isFalse(text.includes("SECRETSDP"));
      assert.isFalse(text.includes("AUDIO_PAYLOAD_SECRET"));
      assert.isFalse(text.includes("v=0"));
      assert.strictEqual((yield* fs.stat(config.voiceLogsDir)).mode & 0o777, 0o700);
      assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);

      yield* fs.remove(config.voiceLogsDir, { recursive: true });
      yield* fs.writeFileString(config.voiceLogsDir, "not-a-directory");
      const again = yield* voice.start(owner, { sdp: offer, mode: "call" });
      assert.strictEqual(again.sessionId, "live-1");
      yield* voice.execute(owner, {
        sessionId: again.sessionId,
        callId: "call-2",
        name: "t3_thread_send",
        arguments: { threadId: "thread" },
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps the MCP error tag while redacting its message", () =>
  Effect.gen(function* () {
    const layer = auditedLayer(
      "live-mcp",
      VoiceTools.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ServerEnvironment.ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
              getDescriptor: Effect.die("unused"),
            }),
            ServerSettings.layerTest({ linkedEnvironmentsEnabled: false }),
            Layer.succeed(McpToolCaller.McpToolCaller, {
              call: () =>
                Effect.fail(
                  new McpSchema.InvalidParams({
                    message: `bad ${secret} ${bearer}`,
                  }),
                ),
            }),
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const voice = yield* VoiceSession.VoiceSession;
      const session = yield* voice.start(owner, { sdp: offer, mode: "call" });
      const refused = yield* voice
        .execute(owner, {
          sessionId: session.sessionId,
          callId: "call-1",
          name: "t3_thread_send",
          arguments: { threadId: "thread" },
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused.reason, "invalid_call");
      const { text, lines } = yield* readVoiceLog("live-mcp");
      const failure = lines.find((line) => line.type === "error");
      assert.strictEqual(failure?.reason, "invalid_call");
      assert.strictEqual(failure?.providerType, "InvalidParams");
      assert.strictEqual(lines.find((line) => line.type === "tool.call")?.status, "error");
      assert.isFalse(text.includes(secret));
      assert.isFalse(text.includes("Bearer"));
      assert.isFalse(text.includes(offer));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("drops voice logs older than 14 days or past 200MB", () =>
  Effect.gen(function* () {
    assert.strictEqual(VoiceAuditLog.VOICE_LOG_MAX_AGE_MS, 14 * 24 * 60 * 60 * 1000);
    assert.strictEqual(VoiceAuditLog.VOICE_LOG_MAX_TOTAL_BYTES, 200 * 1024 * 1024);
    assert.strictEqual(VoiceAuditLog.VOICE_LOG_MAX_FILE_BYTES, 5 * 1024 * 1024);
    const layer = auditedLayer(
      "live-keep",
      Layer.succeed(VoiceTools.VoiceTools, { execute: () => Effect.succeed("{}") }),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(Duration.days(40));
      const voice = yield* VoiceSession.VoiceSession;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = (yield* ServerConfig.ServerConfig).voiceLogsDir;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const ancient = path.join(dir, "19700101-ancient.jsonl");
      const huge = path.join(dir, "19700201-huge.jsonl");
      const tiny = path.join(dir, "19700208-tiny.jsonl");
      yield* fs.writeFileString(ancient, "{}\n");
      yield* fs.writeFileString(huge, "{}\n");
      yield* fs.truncate(huge, VoiceAuditLog.VOICE_LOG_MAX_TOTAL_BYTES + 1);
      yield* fs.writeFileString(tiny, "{}\n");
      const stamp = (file: string, ms: number) => fs.utimes(file, ms / 1000, ms / 1000);
      yield* stamp(ancient, now - VoiceAuditLog.VOICE_LOG_MAX_AGE_MS - 86_400_000);
      yield* stamp(huge, now - 2 * 86_400_000);
      yield* stamp(tiny, now - 3_600_000);
      yield* voice.start(owner, { sdp: offer, mode: "call" });
      const names = yield* fs.readDirectory(dir);
      assert.isFalse(names.includes("19700101-ancient.jsonl"));
      assert.isFalse(names.includes("19700201-huge.jsonl"));
      assert.isTrue(names.includes("19700208-tiny.jsonl"));
      assert.isTrue(names.some((name) => name.endsWith("-live-keep.jsonl")));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("stops a voice log at 5MB with a truncated event", () =>
  Effect.gen(function* () {
    const layer = auditedLayer(
      "live-cap",
      Layer.succeed(VoiceTools.VoiceTools, { execute: () => Effect.succeed("{}") }),
    );
    yield* Effect.gen(function* () {
      const voice = yield* VoiceSession.VoiceSession;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = (yield* ServerConfig.ServerConfig).voiceLogsDir;
      const day = DateTime.formatIsoDateUtc(yield* DateTime.now).replaceAll("-", "");
      const file = path.join(dir, `${day}-live-cap.jsonl`);
      yield* fs.writeFileString(file, "");
      yield* fs.truncate(file, VoiceAuditLog.VOICE_LOG_MAX_FILE_BYTES);
      yield* voice.start(owner, { sdp: offer, mode: "call" });
      const added = (yield* fs.readFileString(file)).slice(VoiceAuditLog.VOICE_LOG_MAX_FILE_BYTES);
      const line = added.trim().split("\n").at(-1);
      assert.strictEqual(JSON.parse(line ?? "").type, "truncated");
      assert.isFalse(added.includes("session.end"));
      assert.isFalse(added.includes(secret));
      assert.isFalse(added.includes("v=0"));
      const size = (yield* fs.stat(file)).size;
      yield* voice.end(owner, "live-cap");
      assert.strictEqual((yield* fs.stat(file)).size, size);
      assert.isFalse((yield* fs.readFileString(file)).includes("session.end"));
    }).pipe(Effect.provide(layer));
  }),
);
