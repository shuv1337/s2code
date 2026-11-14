// @effect-diagnostics nodeBuiltinImport:off -- Executes the installed SDK's private stream producer without a live provider.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

interface Chunk {
  event: { case: string; value: { data?: string } };
}

type StreamHandler = new (
  executor: { execute: () => AsyncGenerator<Chunk> },
  deserialize: () => { id: string; args: { conversationId: string; toolCallId: string } },
  serialize: (id: string, chunk: Chunk) => object,
) => { handle: (context: object, request: object) => AsyncGenerator<unknown> };

it.each(["cjs/305.js", "esm/305.js", "bundled/index.js"])(
  "publishes native shell chunks before yielding them in %s",
  async (build) => {
    const require = NodeModule.createRequire(import.meta.url);
    const directory = NodePath.dirname(require.resolve("@cursor/sdk"));
    const source = NodeFS.readFileSync(NodePath.join(directory, "..", build), "utf8");
    // This private class is not exported; extract it from the installed build, not a copied fixture.
    const marker = source.indexOf("this.serializeStream=");
    expect(marker).toBeGreaterThan(0);
    const start = source.lastIndexOf("class ", marker);
    const end = source.indexOf("class ", marker);
    const listener = vi.fn();
    listener.mockImplementationOnce(() => {
      throw new Error("listener failure must not interrupt the shell");
    });
    const Handler = NodeVM.runInNewContext(`(${source.slice(start, end)})`, {
      performance,
      globalThis: { [Symbol.for("@cursor/sdk.shellStreamOutput")]: listener },
    }) as StreamHandler;
    const chunks: Chunk[] = [
      { event: { case: "stdout", value: { data: "tick 1\n" } } },
      { event: { case: "stderr", value: { data: "warning\n" } } },
      { event: { case: "exit", value: {} } },
    ];
    const handler = new Handler(
      {
        async *execute() {
          yield* chunks;
        },
      },
      () => ({ id: "request", args: { conversationId: "agent", toolCallId: "shell" } }),
      (id, chunk) => ({ id, chunk }),
    );
    const responses = [];
    for await (const response of handler.handle({}, { execId: "exec" })) {
      responses.push(response);
      expect(listener).toHaveBeenCalledTimes(Math.min(responses.length, 2));
    }
    expect(listener.mock.calls).toEqual([
      [{ conversationId: "agent", toolCallId: "shell", event: chunks[0]!.event }],
      [{ conversationId: "agent", toolCallId: "shell", event: chunks[1]!.event }],
    ]);
    expect(responses).toEqual(
      chunks.map((chunk) => ({ id: "request", chunk, localExecutionTimeMs: expect.any(Number) })),
    );
  },
);
