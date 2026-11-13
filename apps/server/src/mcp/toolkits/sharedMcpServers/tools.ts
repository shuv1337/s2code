import {
  McpServerTestResult,
  OrchestratorMcpFailure,
  SharedMcpServerIdInput,
  SharedMcpServerListInput,
  SharedMcpServerListResult,
  SharedMcpServerRemoveResult,
  SharedMcpServerSetInput,
  SharedMcpServerSetResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Management from "../../SharedMcpServerManagement.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    ThreadCommandExecutor.ThreadCommandExecutor,
    Management.SharedMcpServerManagement,
  ],
};
export const SharedMcpServersToolkit = Toolkit.make(
  Tool.make("t3_mcp_server_list", {
    ...shared,
    description: "List shared MCP servers (no tokens).",
    parameters: SharedMcpServerListInput,
    success: SharedMcpServerListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_mcp_server_set", {
    ...shared,
    description:
      "Add/update a shared MCP server; omitted fields keep. Token only via request_secret ref from the target host. Non-empty projectIds limits it to those projects; excludeSubagents hides it from subagents. On a tokened server, changing url/projectIds/excludeSubagents needs a new ref or clearBearerToken.",
    parameters: SharedMcpServerSetInput,
    success: SharedMcpServerSetResult,
  })
    .annotate(Tool.Strict, true)
    .annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_server_remove", {
    ...shared,
    description: "Remove a shared MCP server.",
    parameters: SharedMcpServerIdInput,
    success: SharedMcpServerRemoveResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_server_test", {
    ...shared,
    description: "Test a saved shared MCP server.",
    parameters: SharedMcpServerIdInput,
    success: McpServerTestResult,
  }).annotate(Tool.Destructive, false),
);
