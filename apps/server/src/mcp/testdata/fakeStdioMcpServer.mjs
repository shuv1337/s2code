// A stdio MCP server for StdioMcpBridge tests. Like `executor mcp`, it answers 400-style errors to
// anything sent before it has replied to initialize. Behaviour knobs come from FAKE_MCP_* env vars.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

const initDelay = Number(process.env.FAKE_MCP_INIT_DELAY_MS ?? "50");
const neverInit = process.env.FAKE_MCP_NEVER_INIT === "1";
if (process.env.FAKE_MCP_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  // Keep alive until SIGKILL even after stdin closes.
  setInterval(() => {}, 60_000);
}
let initialized = false;
let early = 0;
const serverRequests = new Map();
const heldById = new Map();
const cancelledIds = [];
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
  if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId;
    if (requestId !== undefined) {
      cancelledIds.push(requestId);
      if (heldById.delete(requestId)) {
        send({
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32800, message: "cancelled" },
        });
      }
    }
    return;
  }
  if (message.id === undefined) return; // notification
  if (message.result !== undefined || message.error !== undefined) {
    const callback = serverRequests.get(message.id);
    if (callback !== undefined) {
      serverRequests.delete(message.id);
      callback(message);
      return;
    }
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
      if (name === "echo") {
        const reply = () =>
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: String(args?.text) }], early },
          });
        if (args?.hold === true) {
          heldById.set(message.id, reply);
          return;
        }
        const delayMs = Number(args?.delayMs ?? 0);
        if (delayMs > 0) setTimeout(reply, delayMs);
        else reply();
        return;
      }
      if (name === "held-count") {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: { count: heldById.size },
        });
      }
      if (name === "cancelled-ids") {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: { ids: [...cancelledIds] },
        });
      }
      if (name === "release-and-echo") {
        const pending = [...heldById.values()];
        heldById.clear();
        for (const reply of pending) reply();
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: String(args?.text) }], early },
        });
      }
      if (name === "big-int") {
        process.stdout.write(
          `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"big":9007199254740993,"nested":{"id":999}}}\n`,
        );
        return;
      }
      if (name === "dup-id") {
        process.stdout.write(
          `{"jsonrpc":"2.0","id":999,"id":${JSON.stringify(message.id)},"result":{"ok":true}}\n`,
        );
        return;
      }
      if (name === "spawn-grandchild") {
        // Install the SIGTERM handler and signal readiness before returning the PID so the test
        // always exercises process-group SIGKILL rather than racing handler registration.
        const grandchild = NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 60000);",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        NodeReadline.createInterface({ input: grandchild.stdout }).once("line", () => {
          grandchild.stdout.resume();
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: String(grandchild.pid) }] },
          });
        });
        return;
      }
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
      if (name === "hang") return; // Keeps the call in flight.
      if (name === "pid")
        return send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: String(process.pid) }] },
        });
      if (name === "flood") {
        const fill = String(args?.char ?? "x").repeat(Number(args?.chars ?? 4096));
        if (args?.terminated === true) {
          // A newline-terminated JSON-RPC response whose byte length exceeds the bridge's cap.
          send({ jsonrpc: "2.0", id: message.id, result: { text: fill } });
        } else {
          // One unterminated line past the bridge's cap.
          process.stdout.write(fill);
        }
        return;
      }
      if (name === "crash") {
        process.stderr.write("crashing on purpose SECRET_TOKEN_DO_NOT_LOG\n");
        process.exit(3);
      }
      if (name === "ask") {
        // Server-initiated request; the bridge must refuse it, then we answer the call.
        serverRequests.set("srv-1", (m) => {
          send({ jsonrpc: "2.0", id: message.id, result: { refused: m.error?.code ?? null } });
        });
        send({ jsonrpc: "2.0", id: "srv-1", method: "sampling/createMessage", params: {} });
        return;
      }
      if (name === "ping-client") {
        serverRequests.set("ping-1", (m) => {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { pong: m.result ?? null, error: m.error ?? null },
          });
        });
        send({ jsonrpc: "2.0", id: "ping-1", method: "ping" });
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
