import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  SecretRef,
  SharedMcpServerSetInput,
  ThreadId,
  type McpServerTestInput,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Management from "../../SharedMcpServerManagement.ts";
import * as SharedMcpServers from "../../SharedMcpServers.ts";
import * as Handlers from "./handlers.ts";
import { SharedMcpServersToolkit } from "./tools.ts";

const id = McpServerId.make("catalog");
const environmentId = EnvironmentId.make("environment:here");
const threadId = ThreadId.make("thread:shared-mcp");
const secretRef = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
const secretKey = "secret-request-0123456789abcdef0123456789abcdef";
const token = "private-fixture-token";
const url = "https://mcp.example.com/api";
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:shared-mcp",
  thread: {
    threadId,
    providerSessionId: "provider:shared-mcp",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const tools = SharedMcpServersToolkit.tools;
const call = <N extends keyof typeof tools>(name: N, input: Tool.Parameters<(typeof tools)[N]>) =>
  SharedMcpServersToolkit.pipe(
    Effect.flatMap((toolkit) => toolkit.handle(name, input)),
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((items) => items.at(-1)?.result),
  );

const fixture = Effect.gen(function* () {
  const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
  const checked = yield* Deferred.make<void>();
  const stored = new Map<string, Uint8Array>([
    [
      secretKey,
      new TextEncoder().encode(
        JSON.stringify({ projectId: "project:mcp-test", value: token, savedAt: 0 }),
      ),
    ],
  ]);
  const tested: McpServerTestInput[] = [];
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    NodeServices.layer,
    ThreadCommandExecutor.layer,
    Settings.ServerSettingsService.layerTest(),
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
    }),
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      set: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
      get: (name) => Effect.sync(() => Option.fromNullishOr(stored.get(name))),
      remove: (name) =>
        Effect.sync(() => {
          stored.delete(name);
        }),
    }),
    Layer.mock(SecretResolver.SecretResolver)({}),
    Layer.mock(SharedMcpServers.SharedMcpServers)({
      test: (input) =>
        Effect.sync(() => {
          tested.push(input);
          return { _tag: "Connected" as const, serverName: "Fixture", tools: ["lookup"] };
        }),
    }),
  );
  const layer = McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Management.layer),
    Layer.provideMerge(SecretRequests.layer),
    Layer.provideMerge(dependencies),
  );
  return { layer, caller, checked, stored, tested };
});

it.effect(
  "lists only public fields, consumes a project-scoped ref, preserves partial updates, clears and removes",
  () =>
    Effect.gen(function* () {
      const harness = yield* fixture;
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const saved = yield* call("t3_mcp_server_set", {
          id,
          url,
          label: "Catalog",
          bearerTokenSecretRef: secretRef,
        });
        expect(saved).toMatchObject({
          server: {
            id,
            url,
            label: "Catalog",
            enabled: true,
            hasToken: true,
            harnessName: "shared-catalog",
          },
          sessionNotice: expect.stringContaining("new provider sessions"),
        });
        expect(harness.stored.has(secretKey)).toBe(false);
        expect((yield* settings.getSettings).mcpServers[id]?.bearerToken).toBe(token);
        const listed = yield* call("t3_mcp_server_list", {});
        expect(listed).toMatchObject({
          servers: [{ id, hasToken: true, harnessName: "shared-catalog" }],
        });
        expect(JSON.stringify([saved, listed])).not.toContain(token);
        expect(JSON.stringify([saved, listed])).not.toContain("bearerToken");
        yield* call("t3_mcp_server_set", { id, enabled: false, label: "Paused" });
        expect((yield* settings.getSettings).mcpServers[id]).toEqual({
          url,
          label: "Paused",
          enabled: false,
          bearerToken: token,
        });
        expect(
          yield* call("t3_mcp_server_set", { id, bearerTokenSecretRef: secretRef }),
        ).toMatchObject({ code: "invalid_request" });
        expect(yield* call("t3_mcp_server_test", { id })).toEqual({
          _tag: "Connected",
          serverName: "Fixture",
          tools: ["lookup"],
        });
        expect(harness.tested).toEqual([{ id, url }]);
        yield* call("t3_mcp_server_set", { id, clearBearerToken: true });
        expect((yield* settings.getSettings).mcpServers[id]?.bearerToken).toBe("");
        expect(yield* call("t3_mcp_server_remove", { id })).toMatchObject({ id });
        expect((yield* settings.getSettings).mcpServers).toEqual({});
        expect(yield* call("t3_mcp_server_test", { id })).toMatchObject({
          code: "invalid_request",
        });
        expect(yield* call("t3_mcp_server_set", { id })).toMatchObject({ code: "invalid_request" });
      }).pipe(Effect.provide(harness.layer));
    }),
);

const decodeSet = Schema.decodeUnknownExit(SharedMcpServerSetInput);
it("rejects invalid ids and URLs and never decodes raw token arguments", () => {
  for (const invalid of [
    { id: "t3-owned", url },
    { id: "Upper", url },
    { id: "x".repeat(25), url },
    { id, url: "ftp://example.com" },
    { id, url: "https://[" },
    { id, url: "https://user:password@example.com" },
  ])
    expect(decodeSet(invalid)._tag).toBe("Failure");
  expect(decodeSet({ id, url, bearerToken: token })).toMatchObject({
    _tag: "Success",
    value: { id, url },
  });
  expect(JSON.stringify(decodeSet({ id, url, bearerToken: token }))).not.toContain(token);
});

it.effect(
  "rejects conflicting or wrong-project refs without spending them, and does not send an old token to a new URL",
  () =>
    Effect.gen(function* () {
      const harness = yield* fixture;
      yield* Effect.gen(function* () {
        expect(
          yield* call("t3_mcp_server_set", {
            id,
            url,
            bearerTokenSecretRef: secretRef,
            clearBearerToken: true,
          }),
        ).toMatchObject({ code: "invalid_request" });
        expect(
          yield* call("t3_mcp_server_set", {
            id,
            url,
            bearerTokenSecretRef: secretRef,
            projectId: ProjectId.make("other"),
          }),
        ).toMatchObject({ code: "invalid_request" });
        expect(harness.stored.has(secretKey)).toBe(true);
        yield* call("t3_mcp_server_set", { id, url, bearerTokenSecretRef: secretRef });
        yield* call("t3_mcp_server_set", { id, url: "https://other.example.com/mcp" });
        const settings = yield* Settings.ServerSettingsService;
        expect((yield* settings.getSettings).mcpServers[id]?.bearerToken).toBe("");
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "refuses supervised, plan, inactive and fenced callers before reading secrets or making changes",
  () =>
    Effect.gen(function* () {
      const harness = yield* fixture;
      yield* Effect.gen(function* () {
        const shell = liveThreadShell(threadId);
        for (const denied of [
          { ...shell, runtimeMode: "approval-required" as const },
          { ...shell, runtimeMode: "auto-accept-edits" as const },
          { ...shell, runtimeMode: "auto" as const },
          { ...shell, interactionMode: "plan" as const },
          { ...shell, activeRunId: null },
          {
            ...shell,
            linkOrigin: { sessionId: "link", label: "Peer", access: "auto-accept-edits" as const },
          },
        ]) {
          yield* Ref.set(harness.caller, denied);
          for (const result of [
            yield* call("t3_mcp_server_list", {}),
            yield* call("t3_mcp_server_set", { id, url, bearerTokenSecretRef: secretRef }),
            yield* call("t3_mcp_server_remove", { id }),
            yield* call("t3_mcp_server_test", { id }),
          ])
            expect(result).toMatchObject({
              code: denied.activeRunId === null ? "parent_not_active" : "capability_denied",
            });
        }
        expect(harness.stored.has(secretKey)).toBe(true);
        expect(harness.tested).toEqual([]);
        const settings = yield* Settings.ServerSettingsService;
        expect((yield* settings.getSettings).mcpServers).toEqual({});
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("rechecks the caller after waiting for its command lock", () =>
  Effect.gen(function* () {
    const harness = yield* fixture;
    yield* Effect.gen(function* () {
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* call("t3_mcp_server_set", {
        id,
        url,
        bearerTokenSecretRef: secretRef,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(harness.checked);
      yield* Ref.update(harness.caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      expect(yield* Fiber.join(update)).toMatchObject({ code: "parent_not_active" });
      expect(harness.stored.has(secretKey)).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "forwards every tool by environmentId without consuming local refs; local modes still apply",
  () =>
    Effect.gen(function* () {
      const harness = yield* fixture;
      const forwarded: Array<{ name: string; environmentId: string; params: unknown }> = [];
      const remote = EnvironmentId.make("environment:remote");
      const forwarding = Layer.mock(PeerForwarding.PeerForwarding)({
        call: (_scope, tool, target, params) =>
          Effect.sync(() => {
            forwarded.push({ name: tool.name, environmentId: target, params });
            const server = {
              id,
              url,
              enabled: true,
              hasToken: true,
              harnessName: "shared-catalog",
            };
            const results = {
              t3_mcp_server_list: {
                servers: [server],
                sessionNotice: "New provider sessions only.",
              },
              t3_mcp_server_set: { server, sessionNotice: "New provider sessions only." },
              t3_mcp_server_remove: { id, sessionNotice: "New provider sessions only." },
              t3_mcp_server_test: { _tag: "Connected", tools: ["lookup"] },
            };
            return results[tool.name as keyof typeof results] as Tool.Success<typeof tool>;
          }),
      });
      yield* Effect.gen(function* () {
        yield* call("t3_mcp_server_list", { environmentId: remote });
        yield* call("t3_mcp_server_set", {
          id,
          url,
          environmentId: remote,
          bearerTokenSecretRef: secretRef,
          projectId: ProjectId.make("remote-project"),
        });
        yield* call("t3_mcp_server_remove", { id, environmentId: remote });
        yield* call("t3_mcp_server_test", { id, environmentId: remote });
        expect(forwarded.map((entry) => entry.name)).toEqual(Object.keys(tools));
        expect(forwarded.every((entry) => entry.environmentId === remote)).toBe(true);
        expect(forwarded[1]?.params).toMatchObject({
          bearerTokenSecretRef: secretRef,
          projectId: "remote-project",
        });
        expect(harness.stored.has(secretKey)).toBe(true);
        yield* Ref.update(harness.caller, (shell) => ({
          ...shell,
          runtimeMode: "approval-required" as const,
        }));
        expect(
          yield* call("t3_mcp_server_set", { id, enabled: false, environmentId: remote }),
        ).toMatchObject({ code: "capability_denied" });
        expect(forwarded).toHaveLength(4);
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(forwarding))));
    }),
);

it.effect(
  "enforces a peer client's access and accepts destination-local refs only with a project",
  () =>
    Effect.gen(function* () {
      const harness = yield* fixture;
      yield* Effect.gen(function* () {
        const asClient = (access: "read-only" | "auto-accept-edits" | "full-access") =>
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            ...scope,
            thread: undefined,
            client: { sessionId: "peer", label: "Peer", linked: true, access },
          });
        for (const access of ["read-only", "auto-accept-edits"] as const)
          expect(
            yield* call("t3_mcp_server_set", { id, url }).pipe(asClient(access)),
          ).toMatchObject({ code: "capability_denied" });
        expect(
          yield* call("t3_mcp_server_set", { id, url, bearerTokenSecretRef: secretRef }).pipe(
            asClient("full-access"),
          ),
        ).toMatchObject({ code: "invalid_request" });
        expect(harness.stored.has(secretKey)).toBe(true);
        expect(
          yield* call("t3_mcp_server_set", {
            id,
            url,
            bearerTokenSecretRef: secretRef,
            projectId: ProjectId.make("project:mcp-test"),
          }).pipe(asClient("full-access")),
        ).toMatchObject({ server: { hasToken: true } });
        expect(harness.stored.has(secretKey)).toBe(false);
      }).pipe(Effect.provide(harness.layer));
    }),
);
