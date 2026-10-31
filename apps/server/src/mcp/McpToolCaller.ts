import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as McpSchema from "effect/ai/McpSchema";

export class McpToolCaller extends Context.Service<
  McpToolCaller,
  {
    readonly call: (
      input: typeof McpSchema.CallTool.payloadSchema.Type,
    ) => Effect.Effect<
      McpSchema.CallToolResult,
      McpSchema.InternalError | McpSchema.InvalidParams,
      McpSchema.McpServerClient
    >;
  }
>()("t3/mcp/McpToolCaller") {}
