import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { TaskFolders } from "../workspace/TaskFolders.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpToolExposure from "../mcp/McpToolExposure.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadIssueService } from "../orchestration-v2/ThreadIssueService.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { ProviderAccountSync } from "../peer/ProviderAccountSync.ts";
import { RemoteDelegation } from "../peer/RemoteDelegation.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { Workflows } from "../workflows/Workflows.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { IssueService } from "../issue/IssueService.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../secrets/SecretRequests.ts";
import { FeedbackStore } from "../feedback/FeedbackStore.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";
import { DocumentText } from "./DocumentText.ts";
import { EnvironmentThemeService } from "../environmentTheme.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import budget from "./agentContextBudget.json" with { type: "json" };

// Registration only stores tool definitions, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  Layer.mock(AnalyticsService)({}),
  Layer.mock(AssetSigner)({}),
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(EnvironmentThemeService)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(TaskFolders)({}),
  Layer.mock(IssueService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(Workflows)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAccountSync)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService)({}),
  Layer.mock(GitManager)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  FetchHttpClient.layer,
  Layer.mock(FeedbackStore)({}),
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-context-budget-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadIssueService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const claudeSystemAppend = () => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "context-budget",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
};

const codexAdditionalContext = () =>
  Object.values(
    buildCodexAdditionalContext(
      { model: "gpt-6.1-sol", modelName: "GPT-6.1 Sol", reasoningEffort: "high" },
      { browser: true, device: true },
    ),
  )
    .map((entry) => entry.value)
    .join("");

const layerAdvertisedTools = McpHttpServer.layerTools.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(toolHandlerServices),
);

const layerAdvertisedToolsWithSearch = Layer.mergeAll(
  McpHttpServer.layerTools,
  McpHttpServer.layerToolSearch,
  McpHttpServer.layerToolExposure,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(toolHandlerServices),
);

// Claude Code loads these tools up front instead of behind ToolSearch, outside this budget.
it.effect("only request_secret and send_to_user ask Claude Code to load them up front", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const alwaysLoad = mcp.tools
      .filter(({ tool }) => tool._meta?.["anthropic/alwaysLoad"] !== undefined)
      .map(({ tool }) => [tool.name, tool._meta]);
    expect(alwaysLoad).toEqual([
      ["request_secret", { "anthropic/alwaysLoad": true }],
      ["send_to_user", { "anthropic/alwaysLoad": true }],
    ]);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);

// CI rejects a PR that raises any value above main's agentContextBudget.json, so growth
// needs the agent-context-increase label. Lower the values when the text shrinks.
it.effect("agent context matches the committed budget", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    // No McpInvocationContext here, so EnabledWhen answers as for an agent, not a peer link.
    const agentTools = mcp.tools.filter(
      ({ annotations }) =>
        Context.getOrUndefined(
          annotations,
          McpSchema.EnabledWhen,
        )?.({
          protocolVersion: "2025-06-18",
          capabilities: {},
        }) ?? true,
    );
    const measured = {
      claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend()),
      codexAdditionalContextBytes: utf8Bytes(codexAdditionalContext()),
      // The model sees these fields. outputSchema and annotations are protocol metadata.
      mcpToolListJsonBytes: utf8Bytes(
        JSON.stringify(
          agentTools.map(({ tool }) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        ),
      ),
    };

    expect(
      measured,
      "Set agentContextBudget.json to the measured values. Before you cut text to fit, run the evals that cover it (evals/README.md).",
    ).toEqual(budget);
  }).pipe(Effect.provide(layerAdvertisedTools)),
);

it.effect("compact eager MCP toolset stays valid and within the agy schema budget", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const agentTools = mcp.tools.filter(
      ({ annotations }) =>
        Context.getOrUndefined(
          annotations,
          McpSchema.EnabledWhen,
        )?.({
          protocolVersion: "2025-06-18",
          capabilities: {},
        }) ?? true,
    );
    const agentToolsByName = new Map(agentTools.map(({ tool }) => [tool.name, tool]));
    const unknownTools = [...McpToolExposure.COMPACT_EAGER_TOOLS].filter(
      (name) => !agentToolsByName.has(name),
    );
    expect(unknownTools).toEqual([]);

    const requiredCoreTools = [
      "delegate_task",
      "create_threads",
      "schedule_task",
      "t3_thread_launch",
      "request_secret",
      "html_render",
      "html_preview",
      "send_to_user",
      "task_status",
      "task_cancel",
      "orchestrator_capabilities",
      "orchestrator_usage_limits",
      "tool_search",
    ];
    for (const toolName of requiredCoreTools) {
      expect(McpToolExposure.COMPACT_EAGER_TOOLS.has(toolName), toolName).toBe(true);
    }

    const compactTools = agentTools
      .filter(({ tool }) => McpToolExposure.COMPACT_EAGER_TOOLS.has(tool.name))
      .map(({ tool }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    const compactBytes = utf8Bytes(JSON.stringify(compactTools));
    expect(compactBytes).toBeLessThanOrEqual(38_000);
  }).pipe(Effect.provide(layerAdvertisedToolsWithSearch)),
);

it.effect("compact dynamic tool_search stays bounded and skips already-eager tools", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const exposure = yield* McpToolExposure.McpToolExposure;
    const agentTools = mcp.tools.filter(
      ({ annotations }) =>
        Context.getOrUndefined(
          annotations,
          McpSchema.EnabledWhen,
        )?.({
          protocolVersion: "2025-06-18",
          capabilities: {},
        }) ?? true,
    );
    const sessionId = "compact-budget-session";
    const maxListedBytes = 38_000 + McpToolExposure.COMPACT_DYNAMIC_MAX_BYTES;
    const listedBytes = () =>
      utf8Bytes(
        JSON.stringify(
          agentTools
            .filter(({ tool }) => exposure.isListed(sessionId, tool.name, "compact"))
            .map(({ tool }) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
        ),
      );

    const initialBytes = listedBytes();
    const expectWithinBudget = (label: string) => {
      const currentBytes = listedBytes();
      expect(currentBytes - initialBytes, `${label} dynamic delta`).toBeLessThanOrEqual(
        McpToolExposure.COMPACT_DYNAMIC_MAX_BYTES,
      );
      expect(currentBytes, `${label} total`).toBeLessThanOrEqual(maxListedBytes);
    };

    const previewHits = yield* exposure.search(sessionId, "preview", "compact");
    expect(previewHits.length).toBeGreaterThan(0);
    expect(previewHits.every((hit) => !McpToolExposure.COMPACT_EAGER_TOOLS.has(hit.name))).toBe(
      true,
    );
    expectWithinBudget("preview");

    for (const query of ["project", "device", "worktree", "attachment"]) {
      const hits = yield* exposure.search(sessionId, query, "compact");
      expect(hits.length, query).toBeGreaterThan(0);
      expect(
        hits.every((hit) => !McpToolExposure.COMPACT_EAGER_TOOLS.has(hit.name)),
        query,
      ).toBe(true);
      expectWithinBudget(query);
    }

    const threadHits = yield* exposure.search(sessionId, "thread", "compact");
    expect(threadHits.map((hit) => hit.name)).toContain("t3_thread_send_attachments");
    expect(threadHits.every((hit) => !McpToolExposure.COMPACT_EAGER_TOOLS.has(hit.name))).toBe(
      true,
    );
    expectWithinBudget("thread");
    expect(exposure.isListed(sessionId, "t3_thread_send_attachments", "compact")).toBe(true);
    // Earlier dynamic search hits were evicted to keep the compact window bounded.
    expect(previewHits.some((hit) => !exposure.isListed(sessionId, hit.name, "compact"))).toBe(
      true,
    );
  }).pipe(Effect.provide(layerAdvertisedToolsWithSearch)),
);
