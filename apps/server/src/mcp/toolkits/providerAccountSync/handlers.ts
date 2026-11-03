import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProviderAccountSync from "../../../peer/ProviderAccountSync.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProviderAccountSyncToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ProviderAccountSyncToolkit, {
  t3_provider_account_sync: McpToolAccess.writesEnvironment(
    ({ records }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (scope.client?.linked !== true)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only a linked T3 Code environment exchanges account states.",
          });
        const sync = yield* ProviderAccountSync.ProviderAccountSync;
        return { environmentId: scope.environmentId, records: yield* sync.exchange(records) };
      }),
    { linkedCallers: "allowed" },
  ),
});
