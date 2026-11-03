import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProviderAccountSync from "../../../peer/ProviderAccountSync.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ProviderAccountSyncToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ProviderAccountSyncToolkit, {
  t3_provider_account_sync: McpToolAccess.writesEnvironment(
    ({ from, records }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (scope.client?.linked !== true)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only a linked T3 Code environment exchanges account states.",
          });
        const sync = yield* ProviderAccountSync.ProviderAccountSync;
        // Named by the label its link was paired under, as Sharing & access lists it.
        const local = yield* sync.exchange(records, {
          environmentId: from,
          label: scope.client.label,
        });
        return { environmentId: scope.environmentId, records: local };
      }),
    { linkedCallers: "allowed" },
  ),
});
