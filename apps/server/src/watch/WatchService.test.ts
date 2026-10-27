import { assert, test } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type WatchCommandEnvelope,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as Watch from "./WatchService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WatchHttp from "./http.ts";
import * as WatchTranscription from "./WatchTranscription.ts";
import * as LocalTranscription from "../transcription/LocalTranscription.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as WatchPairingStore from "../auth/WatchPairingStore.ts";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import * as HttpServer from "effect/http/HttpServer";

// Bind Effect helpers to this suite's Vite+ instance (pnpm can install a second peer instance).
const it = makeMethods(test);
const isWatchServiceError = Schema.is(Watch.WatchServiceError);
const environmentId = EnvironmentId.make("watch-test");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const projectId = ProjectId.make("project:watch");
const now = DateTime.makeUnsafe("2026-10-10T10:00:00Z");
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("The adapter boundary test never starts a worker"),
};
const database = Sqlite.layerMemory;
const runtime = ProviderReplayHarness.layerWithRegistry(
  { name: "watch-http" },
  ProviderAdapterRegistry.layerSingle(adapter),
  { databaseLayer: database, runEffectWorker: false },
);
const dependencies = Layer.mergeAll(
  ThreadManagement.layer.pipe(
    Layer.provide(runtime),
    Layer.provide(Receipts.layer.pipe(Layer.provide(database))),
    Layer.provide(ServerSettings.layerTest()),
  ),
  ProjectionStore.layer,
  Receipts.layer,
  ProjectStore.layer,
  ApplicationEvents.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed({
      environmentId,
      label: "Test environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "test",
      capabilities: { repositoryIdentity: true },
    } as const),
  }),
  Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
    getInstance: () => Effect.succeed(undefined),
  }),
).pipe(Layer.provideMerge(database), Layer.provideMerge(runtime));
const layer = Watch.layer.pipe(Layer.provideMerge(dependencies));
const httpLayer = WatchHttp.layer.pipe(
  Layer.provide(
    WatchTranscription.layer.pipe(
      Layer.provide(layer),
      Layer.provide(
        Layer.succeed(LocalTranscription.LocalTranscription, {
          transcribe: () => Effect.succeed("A local transcript."),
        }),
      ),
    ),
  ),
  Layer.provide(layer),
  Layer.provide(Layer.mock(WatchPairingStore.WatchPairingStore)({})),
  Layer.provideMerge(
    WatchHttp.layerAuthenticatedAuth.pipe(
      Layer.provide(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          authenticateWatchClient: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("watch-session"),
              subject: "watch-client",
              method: "bearer-access-token",
              scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
              restriction: { threadIds: [] },
            }),
        }),
      ),
    ),
  ),
  Layer.provide(HttpServer.layerServices),
);

it.effect("serves compact HTTP capabilities and applies authenticated restrictions", () =>
  Effect.gen(function* () {
    const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["watch"]);
    const capabilities = yield* client.watch.capabilities({ headers: {} });
    assert.equal(capabilities.environmentId, environmentId);
    assert.equal(capabilities.limits.maxBodyBytes, 48 * 1024);
    const threads = yield* client.watch.threads({ headers: {}, query: {} });
    assert.deepEqual(threads.items, []);
    const denied = yield* client.watch
      .thread({ headers: {}, params: { threadId: ThreadId.make("hidden") } })
      .pipe(Effect.flip);
    assert.equal(denied._tag, "WatchRequestError");
    const voiceDenied = yield* client.watch
      .transcription({
        headers: {},
        params: { threadId: ThreadId.make("hidden") },
        payload: { audioBase64: Buffer.alloc(60_000).toString("base64") },
      })
      .pipe(Effect.flip);
    assert.equal(voiceDenied._tag, "WatchRequestError");
    if (voiceDenied._tag === "WatchRequestError") assert.equal(voiceDenied.code, "forbidden");
  }).pipe(Effect.provide(Layer.merge(httpLayer, HttpServer.layerServices))),
);

const createThread = Effect.fnUntraced(function* (name: string, project = projectId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(name);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: project,
    title: name,
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* projection.apply({
    id: EventId.make(`session:${name}`),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: ProviderSessionId.make(`session:${name}`),
      providerInstanceId: instanceId,
      driver,
      status: "ready",
      cwd: "/test",
      model: "test",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  return threadId;
});

const envelope = (threadId: ThreadId): WatchCommandEnvelope => ({
  protocolVersion: 1,
  commandId: CommandId.make("11111111-1111-4111-8111-111111111111"),
  messageId: MessageId.make("22222222-2222-4222-8222-222222222222"),
  environmentId,
  threadId,
  action: "send",
  text: "hello",
  notAfter: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
});

it.effect(
  "commits an idle send through the real orchestrator and rejects changed-content replay",
  () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("real-dispatch");
      const service = yield* Watch.WatchService;
      const result = yield* service.submitCommand({
        envelope: envelope(threadId),
        principal: "watch-session",
      });
      assert.equal(result.status, "accepted");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.messages[0]?.text, "hello");
      const conflict = yield* service.submitCommand({
        envelope: { ...envelope(threadId), text: "different" },
        principal: "watch-session",
      });
      assert.equal(conflict.status, "rejected");
      assert.equal(conflict.error?.code, "command_conflict");
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).messages.length, 1);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("paginates pinned first with deterministic ties and filters before LIMIT", () =>
  Effect.gen(function* () {
    const service = yield* Watch.WatchService;
    const sql = yield* SqlClient.SqlClient;
    const a = yield* createThread("a");
    const b = yield* createThread("b");
    const c = yield* createThread("c", ProjectId.make("other"));
    yield* sql`UPDATE orchestration_v2_projection_threads SET updated_at = '2026-10-10T10:00:00.000Z'`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.pinnedAt', '2026-10-09T10:00:00.000Z') WHERE thread_id = ${a}`;
    const first = yield* service.listThreads({ limit: 1 });
    assert.deepEqual(
      first.items.map((item) => item.threadId),
      [a],
    );
    assert.isNotNull(first.nextCursor);
    const second = yield* service.listThreads({ limit: 1, cursor: first.nextCursor! });
    assert.deepEqual(
      second.items.map((item) => item.threadId),
      [c],
    );
    const third = yield* service.listThreads({ limit: 1, cursor: second.nextCursor! });
    assert.deepEqual(
      third.items.map((item) => item.threadId),
      [b],
    );
    assert.isNull(third.nextCursor);
    const filtered = yield* service.listThreads({
      limit: 1,
      restriction: { projectIds: [projectId], threadIds: [b, c] },
    });
    assert.deepEqual(
      filtered.items.map((item) => item.threadId),
      [b],
    );
    assert.isNull(filtered.nextCursor);
    assert.deepEqual(
      (yield* service.listThreads({ limit: 20, restriction: { threadIds: [] } })).items,
      [],
    );
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("replays an in-lock rejection as the same rejected receipt", () =>
  Effect.gen(function* () {
    const threadId = yield* createThread("idle-queue");
    const service = yield* Watch.WatchService;
    const input = {
      envelope: { ...envelope(threadId), action: "queue" as const },
      principal: "watch-session",
    };
    const first = yield* service.submitCommand(input);
    assert.equal(first.error?.code, "thread_idle");
    const replay = yield* service.submitCommand(input);
    assert.deepEqual(replay, first);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "projects native subagent lineage, provider capabilities and bounded assistant excerpt",
  () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("child");
      const service = yield* Watch.WatchService;
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,
    '$.creationSource', 'provider', '$.lineage.relationshipToParent', 'subagent', '$.lineage.parentThreadId', 'parent') WHERE thread_id = ${threadId}`;
      yield* projections.apply({
        id: EventId.make("assistant"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: MessageId.make("assistant"),
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text: "x".repeat(1000),
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: now,
          updatedAt: now,
        },
      });
      const result = yield* service.getThread({ threadId });
      assert.equal(result.latestAssistantExcerpt?.length, 280);
      assert.equal(result.isReadOnly, true);
      assert.equal(result.parentThreadId, "parent");
      assert.equal(result.provider, driver);
      assert.equal(result.capabilities.supportsActiveSteering, true);
      assert.equal(result.activity, "idle");
      const threads = yield* ThreadManagement.ThreadManagementService;
      const original = yield* threads.getThreadShell(threadId);
      assert.isNotNull(original);
      const unknown = Layer.fresh(Watch.layer).pipe(
        Layer.provide(
          Layer.succeed(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadShell: () =>
              Effect.succeed({
                ...original!,
                status: "future-state" as typeof original extends null
                  ? never
                  : NonNullable<typeof original>["status"],
              }),
          }),
        ),
      );
      const summary = yield* Effect.flatMap(Watch.WatchService, (watch) =>
        watch.getThread({ threadId }),
      ).pipe(Effect.provide(unknown));
      assert.equal(summary.activity, "unknown");
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "rejects invalid target and text before dispatch, and sends exactly the strict dispatch command",
  () =>
    Effect.gen(function* () {
      const threadId = yield* createThread("send");
      const native = yield* createThread("native");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.creationSource', 'provider', '$.lineage.relationshipToParent', 'subagent', '$.lineage.parentThreadId', 'parent') WHERE thread_id = ${native}`;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const commands: OrchestrationV2ServerCommand[] = [];
      const receipt = {
        commandId: envelope(threadId).commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: now,
        resultSequence: 1,
        status: "accepted" as const,
        error: null,
        principal: "watch-session",
        admissionAction: "send" as const,
        payloadFingerprint: null,
      };
      const serviceLayer = Layer.fresh(Watch.layer).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ThreadManagement.ThreadManagementService, {
              ...threads,
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 1, storedEvents: [] };
                }),
            }),
            Layer.mock(Receipts.CommandReceiptStoreV2)({
              getByCommandId: (commandId) =>
                Effect.succeed(
                  commandId === receipt.commandId ? Option.some(receipt) : Option.none(),
                ),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* Watch.WatchService;
        for (const [input, code] of [
          [
            { envelope: { ...envelope(threadId), environmentId: EnvironmentId.make("wrong") } },
            "environment_mismatch",
          ],
          [{ envelope: envelope(threadId), restriction: { threadIds: [] } }, "forbidden"],
          [{ envelope: envelope(native) }, "thread_read_only"],
          [{ envelope: { ...envelope(threadId), text: "🙂".repeat(8193) } }, "text_too_long"],
        ] as const) {
          const error = yield* service
            .submitCommand({ ...input, principal: "watch-session" })
            .pipe(Effect.flip);
          assert.equal(error._tag, "WatchServiceError");
          assert.equal(isWatchServiceError(error) && error.code, code);
        }
        assert.equal(commands.length, 0);
        const result = yield* service.submitCommand({
          envelope: envelope(threadId),
          principal: "watch-session",
        });
        assert.equal(result.status, "accepted");
        assert.equal(commands.length, 1);
        const command = commands[0]!;
        assert.equal(command.type, "message.dispatch");
        if (command.type !== "message.dispatch") return;
        assert.deepEqual(command.dispatchMode, { type: "start_immediately" });
        assert.equal(command.admission?.kind, "watch");
        assert.deepEqual(command.admission?.constraint, { type: "requireIdle" });
        assert.equal(command.steerFollowUpPolicy, "none");
        assert.equal(command.principal, "watch-session");
        const denied = yield* service
          .getReceipt({
            commandId: receipt.commandId,
            principal: "watch-session",
            restriction: { projectIds: [] },
          })
          .pipe(Effect.flip);
        assert.equal(isWatchServiceError(denied) && denied.code, "forbidden");
        const otherPrincipal = yield* service
          .getReceipt({ commandId: receipt.commandId, principal: "other" })
          .pipe(Effect.flip);
        assert.equal(isWatchServiceError(otherPrincipal) && otherPrincipal.code, "forbidden");
        const missing = yield* service
          .getReceipt({
            commandId: CommandId.make("00000000-0000-4000-8000-000000000000"),
            principal: "watch-session",
          })
          .pipe(Effect.flip);
        assert.equal(isWatchServiceError(missing) && missing.code, "receipt_not_found");
      }).pipe(Effect.provide(serviceLayer));
    }).pipe(Effect.provide(layer), Effect.scoped),
);
