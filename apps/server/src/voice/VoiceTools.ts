import { VoiceError, type AuthEnvironmentScope } from "@t3tools/contracts";
import { clientRequestIdPolicyFor } from "@t3tools/shared/voice/allowlist";
import { summarizeToolResult } from "@t3tools/shared/voice/resultSummary";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpToolCaller from "../mcp/McpToolCaller.ts";
import * as McpSchema from "effect/ai/McpSchema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

export interface VoiceCaller {
  readonly sessionId: string;
  readonly scopes: readonly AuthEnvironmentScope[];
}
export class VoiceTools extends Context.Service<
  VoiceTools,
  {
    readonly execute: (
      caller: VoiceCaller,
      name: string,
      args: Readonly<Record<string, unknown>>,
      callId: string,
    ) => Effect.Effect<string, VoiceError>;
  }
>()("t3/voice/VoiceTools") {}
const make = Effect.gen(function* () {
  const mcp = yield* McpToolCaller.McpToolCaller;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const execute = Effect.fn("VoiceTools.execute")(function* (
    caller: VoiceCaller,
    name: string,
    args: Readonly<Record<string, unknown>>,
    callId: string,
  ) {
    const required: AuthEnvironmentScope[] = ["orchestration:read", "orchestration:operate"];
    if (name.startsWith("t3_environment_")) required.push("access:read");
    if (name === "t3_environment_link" || name === "t3_environment_unlink")
      required.push("access:write");
    if (name === "t3_project_clone" || name === "t3_worktree_handoff")
      required.push("source-control:write");
    if (name.startsWith("t3_preview_")) required.push("preview:operate");
    if (required.some((scope) => !caller.scopes.includes(scope)))
      return yield* new VoiceError({ reason: "forbidden" });
    const parameters = { ...args };
    if (clientRequestIdPolicyFor(name) === "overwrite") parameters.clientRequestId = callId;
    else delete parameters.clientRequestId;
    const environmentId = yield* environment.getEnvironmentId;
    const result = yield* mcp.call({ name, arguments: parameters }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId,
        capabilities: new Set(["orchestration", "worktree", "preview"] as const),
        issuedAt: 0,
        requestNamespace: `voice:${caller.sessionId}`,
        thread: undefined,
        client: { sessionId: caller.sessionId, label: "Voice", access: "full-access" },
      }),
      Effect.provideService(McpSchema.McpServerClient, {
        clientId: 0,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "voice", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "voice", version: "1" },
        },
        getClient: Effect.die("Voice has no MCP client requests"),
      }),
      Effect.mapError(() => new VoiceError({ reason: "invalid_call" })),
    );
    return summarizeToolResult({
      tool: name,
      content: result.content,
      maxChars: 4000,
      ok: !result.isError,
    });
  });
  return VoiceTools.of({ execute });
});
export const layer = Layer.effect(VoiceTools, make);
