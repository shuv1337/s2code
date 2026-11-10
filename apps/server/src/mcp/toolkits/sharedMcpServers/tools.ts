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
    description: "List shared MCP servers, never tokens. Full access required.",
    parameters: SharedMcpServerListInput,
    success: SharedMcpServerListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_mcp_server_set", {
    ...shared,
    description:
      "Upsert a shared MCP server. Omitted fields stay. Token: request_secret ref on destination host.",
    parameters: SharedMcpServerSetInput,
    success: SharedMcpServerSetResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_server_remove", {
    ...shared,
    description: "Remove a shared MCP server.",
    parameters: SharedMcpServerIdInput,
    success: SharedMcpServerRemoveResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_mcp_server_test", {
    ...shared,
    description: "Test a saved shared MCP server with its stored token.",
    parameters: SharedMcpServerIdInput,
    success: McpServerTestResult,
  }).annotate(Tool.Destructive, false),
);
