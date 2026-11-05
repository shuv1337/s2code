import {
  type ModelSelection,
  OrchestratorMcpFailure,
  type ProjectId,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { usageLimitPoolDriver, usageLimitPoolStart } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";

/** Where a pooled start lands; every tool that takes a pool refuses with the same codes. */
export const poolStartSelection = Effect.fn("mcp.poolStartSelection")(function* (input: {
  readonly pool: ProviderDriverKind;
  readonly model: string | undefined;
  readonly inherited: ModelSelection | undefined;
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: ProjectId | null;
  readonly now: number;
}): Effect.fn.Return<ModelSelection, OrchestratorMcpFailure> {
  const model =
    input.model ??
    (input.inherited !== undefined &&
    usageLimitPoolDriver(input.settings, input.inherited.instanceId) === input.pool
      ? input.inherited.model
      : undefined);
  if (model === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Pass a model with the pool.",
    });
  }
  const started = usageLimitPoolStart({ ...input, model });
  if ("selection" in started) return started.selection;
  return yield* new OrchestratorMcpFailure({
    code: started.reason === "model_not_shared" ? "model_unavailable" : "provider_unavailable",
    message: started.error,
  });
});
