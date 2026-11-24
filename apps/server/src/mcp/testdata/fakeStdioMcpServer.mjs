// A stdio MCP server for StdioMcpBridge tests. Like `executor mcp`, it answers 400-style errors to
// anything sent before it has replied to initialize. Behaviour knobs come from FAKE_MCP_* env vars.
import * as NodeReadline from "node:readline";

const initDelay = Number(process.env.FAKE_MCP_INIT_DELAY_MS ?? "50");
const neverInit = process.env.FAKE_MCP_NEVER_INIT === "1";
let initialized = false;
let early = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
process.stderr.write(`fake server started pid=${process.pid}\n`);

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (neverInit) return;
    setTimeout(() => {
      initialized = true;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-stdio", version: "1" },
        },
      });
    }, initDelay);
    return;
  }
  if (!initialized) {
    early += 1;
    if (message.id !== undefined)
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32600, message: "HTTP 400: not initialized" },
      });
    return;
  }
  if (message.id === undefined) return; // notification
  if (message.result !== undefined || message.error !== undefined) {
    process.stderr.write(`client answered ${JSON.stringify(message)}\n`);
    return;
  }
  switch (message.method) {
    case "tools/list":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "echo", inputSchema: { type: "object" } },
            { name: "env" },
            { name: "crash" },
            { name: "ask" },
          ],
        },
      });
    case "tools/call": {
      const { name, arguments: args } = message.params;
      if (name === "echo")
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: String(args?.text) }], early },
        });
      if (name === "env")
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  secret: process.env.T3_BRIDGE_TEST_SECRET ?? null,
                  configured: process.env.FAKE_MCP_CONFIGURED ?? null,
                }),
              },
            ],
          },
        });
      if (name === "crash") {
        process.stderr.write("crashing on purpose\n");
        process.exit(3);
      }
      if (name === "ask") {
        // Server-initiated request; the bridge must refuse it, then we answer the call.
        send({ jsonrpc: "2.0", id: "srv-1", method: "sampling/createMessage", params: {} });
        const wait = (l) => {
          const m = JSON.parse(l);
          if (m.id === "srv-1") {
            send({ jsonrpc: "2.0", id: message.id, result: { refused: m.error?.code ?? null } });
          }
        };
        NodeReadline.createInterface({ input: process.stdin }).once("line", wait);
        return;
      }
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "unknown tool" },
      });
    }
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "not found" },
      });
  }
});
