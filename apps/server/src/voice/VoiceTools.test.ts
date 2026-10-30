import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpSchema from "effect/ai/McpSchema";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpToolCaller from "../mcp/McpToolCaller.ts";
import * as VoiceTools from "./VoiceTools.ts";

it.effect("requires each tool's grants before invoking it and bounds sensitive results", () =>
  Effect.gen(function* () {
    let calls = 0;
    const layer = VoiceTools.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
            getDescriptor: Effect.die("unused"),
          }),
          Layer.succeed(McpToolCaller.McpToolCaller, {
            call: () =>
              Effect.sync(() => {
                calls++;
                return new McpSchema.CallToolResult({
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        apiKey: "fixture-secret",
                        text: "long result ".repeat(1000),
                      }),
                    },
                  ],
                });
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const voice = yield* VoiceTools.VoiceTools;
      const caller = {
        sessionId: "paired",
        scopes: ["orchestration:read", "orchestration:operate"],
      } as const;
      const denied = yield* voice
        .execute(caller, "t3_environment_link", {}, "call-1")
        .pipe(Effect.flip);
      assert.strictEqual(denied.reason, "forbidden");
      assert.strictEqual(calls, 0);
      const output = yield* voice.execute(
        caller,
        "t3_thread_send",
        { threadId: "thread" },
        "call-2",
      );
      assert.strictEqual(calls, 1);
      assert.isFalse(output.includes("fixture-secret"));
      assert.include(output, "[redacted]");
      assert.isAtMost(output.length, 4001);
    }).pipe(Effect.provide(layer));
  }),
);
