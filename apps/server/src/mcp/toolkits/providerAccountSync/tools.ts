import {
  OrchestratorMcpFailure,
  ProviderAccountSyncInput,
  ProviderAccountSyncResult,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAccountSync from "../../../peer/ProviderAccountSync.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProviderAccountSyncTool = Tool.make("t3_provider_account_sync", {
  description: "Exchange spent-quota account states with a linked environment.",
  parameters: ProviderAccountSyncInput,
  success: ProviderAccountSyncResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderAccountSync.ProviderAccountSync,
  ],
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForLinks);

export const ProviderAccountSyncToolkit = Toolkit.make(ProviderAccountSyncTool);
