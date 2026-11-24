// Relays JSON-RPC verbatim between the shared-server proxy and local processes; schema decoding would reject foreign payloads.
// A process-lifecycle core in plain Node, wrapped by a small Effect service at the end.
// @effect-diagnostics globalJsonInEffect:off nodeBuiltinImport:off globalDate:off globalTimers:off effectFnOpportunity:off runEffectInsideEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import type { McpServerStdioConfig } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** What the proxy sends back; the body is always JSON (or empty for 202/204/404). */
export interface StdioBridgeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface StdioBridgeRequest {
  readonly serverId: string;
  readonly server: Pick<McpServerStdioConfig, "command" | "args" | "env">;
  /** Sessions belong to the thread that opened them; another thread's id is unknown to it. */
  readonly owner: string;
  readonly method: "POST" | "GET" | "DELETE";
  readonly sessionId: string | undefined;
  readonly body: string;
}

export interface StdioMcpBridgeOptions {
  /** Children across every server; each costs ~100+ MB. */
  readonly maxSessions?: number;
  readonly maxSessionsPerServer?: number;
  /** A stdout line longer than this closes the session instead of growing the buffer. */
  readonly maxMessageChars?: number;
  readonly idleTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly stderrBytes?: number;
  readonly killGraceMs?: number;
  /** Variables the child inherits from this server; everything else comes from the entry's env. */
  readonly inheritEnv?: ReadonlyArray<string>;
}

const DEFAULT_INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
];

type JsonRpcId = string | number;
interface Envelope {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const isRecord = (value: unknown): value is Envelope =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || typeof value === "number";
const idKey = (id: JsonRpcId) => JSON.stringify(id);

const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(payload),
});
const rpcError = (id: JsonRpcId | null, message: string, code = -32000) =>
  json(200, { jsonrpc: "2.0", id, error: { code, message } });
const empty = (status: number): StdioBridgeResponse => ({ status, headers: {}, body: "" });

/** The binding a session was spawned for; a settings edit retires sessions that no longer match it. */
export const stdioServerFingerprint = (server: StdioBridgeRequest["server"]) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        server.command,
        server.args,
        Object.entries(server.env).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest("hex");

interface Pending {
  readonly resolve: (response: StdioBridgeResponse) => void;
}

class StdioSession {
  readonly id = NodeCrypto.randomUUID();
  private readonly pending = new Map<string, Pending>();
  private buffered = "";
  private stderr = "";
  private initialized = false;
  private readonly waiting: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  lastUsed = Date.now();
  closed = false;

  readonly serverId: string;
  readonly owner: string;
  readonly fingerprint: string;
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly options: Required<StdioMcpBridgeOptions>;
  private readonly onClose: (session: StdioSession, reason: string) => void;

  constructor(
    serverId: string,
    owner: string,
    fingerprint: string,
    child: NodeChildProcess.ChildProcessWithoutNullStreams,
    options: Required<StdioMcpBridgeOptions>,
    onClose: (session: StdioSession, reason: string) => void,
  ) {
    this.serverId = serverId;
    this.owner = owner;
    this.fingerprint = fingerprint;
    this.child = child;
    this.options = options;
    this.onClose = onClose;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-options.stderrBytes);
    });
    child.stdin.on("error", () => this.close("its stdin closed"));
    child.on("error", (error) => this.close(`it could not start (${error.message})`));
    child.on("exit", (code, signal) =>
      this.close(`it exited (${signal ?? `code ${code ?? "unknown"}`})`),
    );
    this.touch();
  }

  get stderrTail() {
    return this.stderr;
  }

  touch() {
    this.lastUsed = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close("it was idle"), this.options.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  /** A request is waiting on it, initialize included, so evicting it would cut a call short. */
  get busy() {
    return this.pending.size > 0;
  }

  private read(chunk: string) {
    if (this.closed) return;
    this.buffered += chunk;
    let newline = this.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (line.length > 0) this.receive(line);
      newline = this.buffered.indexOf("\n");
    }
    if (this.buffered.length > this.options.maxMessageChars) {
      this.buffered = "";
      this.close(`it sent a message over ${this.options.maxMessageChars} characters`);
    }
  }

  private receive(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Servers that log to stdout break the protocol; skip the line rather than the session.
    }
    if (!isRecord(message)) return;
    if (typeof message.method === "string") {
      // No GET stream, so server-initiated requests (sampling, elicitation, roots) can't reach the harness.
      if (isId(message.id)) {
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Not supported through T3 Code's shared MCP bridge." },
        });
      }
      return;
    }
    if (!isId(message.id)) return;
    const pending = this.pending.get(idKey(message.id));
    if (pending === undefined) return;
    this.pending.delete(idKey(message.id));
    pending.resolve({ status: 200, headers: { "content-type": "application/json" }, body: line });
  }

  private write(message: unknown) {
    if (this.closed) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  /** Every message but initialize waits for the server's initialize result. */
  private ready(): Promise<void> {
    return this.initialized || this.closed
      ? Promise.resolve()
      : new Promise((resolve) => this.waiting.push(resolve));
  }

  markInitialized() {
    this.initialized = true;
    for (const resume of this.waiting.splice(0)) resume();
  }

  request(id: JsonRpcId, message: unknown, gated: boolean): Promise<StdioBridgeResponse> {
    const key = idKey(id);
    if (this.pending.has(key))
      return Promise.resolve(rpcError(id, "Duplicate request id.", -32600));
    return new Promise((resolve) => {
      this.pending.set(key, { resolve });
      const send = () => {
        if (this.closed) return; // close() already answered it.
        this.write(message);
      };
      if (gated) void this.ready().then(send);
      else send();
    });
  }

  async notify(message: unknown): Promise<void> {
    await this.ready();
    this.write(message);
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const resume of this.waiting.splice(0)) resume();
    for (const [key, pending] of this.pending) {
      pending.resolve(
        rpcError(
          JSON.parse(key) as JsonRpcId,
          `The MCP server process stopped before answering: ${reason}.`,
        ),
      );
    }
    this.pending.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null)
          this.child.kill("SIGKILL");
      }, this.options.killGraceMs);
      force.unref?.();
    }
    this.onClose(this, reason);
  }
}

/**
 * Serves stdio MCP servers on the shared proxy route. Each harness session gets its own child,
 * started on initialize and stopped on DELETE, idle, crash, a settings change or shutdown. A lost
 * session answers 404 so the harness initializes again; nothing is replayed.
 */
export class StdioMcpBridgeCore {
  private readonly sessions = new Map<string, StdioSession>();
  private readonly options: Required<StdioMcpBridgeOptions>;

  private readonly log: (message: string, details: Record<string, unknown>) => void;

  constructor(
    options: StdioMcpBridgeOptions = {},
    log: (message: string, details: Record<string, unknown>) => void = () => {},
  ) {
    this.log = log;
    this.options = {
      maxSessions: options.maxSessions ?? 6,
      maxSessionsPerServer: options.maxSessionsPerServer ?? 4,
      maxMessageChars: options.maxMessageChars ?? 8 * 1024 * 1024,
      idleTimeoutMs: options.idleTimeoutMs ?? 10 * 60_000,
      initializeTimeoutMs: options.initializeTimeoutMs ?? 10_000,
      stderrBytes: options.stderrBytes ?? 16 * 1024,
      killGraceMs: options.killGraceMs ?? 2_000,
      inheritEnv: options.inheritEnv ?? DEFAULT_INHERITED_ENV,
    };
  }

  get sessionCount() {
    return this.sessions.size;
  }

  /** Live child pids, for tests and diagnostics. */
  pids(serverId?: string): ReadonlyArray<number> {
    return [...this.sessions.values()]
      .filter((session) => serverId === undefined || session.serverId === serverId)
      .flatMap((session) => (session.child.pid === undefined ? [] : [session.child.pid]));
  }

  closeAll(reason = "T3 Code stopped") {
    for (const session of this.sessions.values()) session.close(reason);
  }

  /** Stops every session of a server, e.g. after it is removed or disabled. */
  closeServer(serverId: string, reason: string) {
    for (const session of this.sessions.values()) {
      if (session.serverId === serverId) session.close(reason);
    }
  }

  async handle(request: StdioBridgeRequest): Promise<StdioBridgeResponse> {
    if (request.method === "GET") return empty(405); // No server-to-client stream; the spec allows 405.
    const fingerprint = stdioServerFingerprint(request.server);
    const session =
      request.sessionId === undefined ? undefined : this.sessions.get(request.sessionId);
    const owned =
      session !== undefined &&
      session.serverId === request.serverId &&
      session.owner === request.owner;
    if (owned && session.fingerprint !== fingerprint) session.close("its settings changed");
    const live = owned && !session.closed ? session : undefined;

    if (request.method === "DELETE") {
      live?.close("the harness ended its session");
      return empty(live === undefined ? 404 : 200);
    }

    let message: unknown;
    try {
      message = JSON.parse(request.body);
    } catch {
      return rpcError(null, "Parse error.", -32700);
    }
    if (Array.isArray(message)) return rpcError(null, "Batches are not supported.", -32600);
    if (!isRecord(message)) return rpcError(null, "Invalid request.", -32600);

    if (message.method === "initialize") {
      if (!isId(message.id)) return rpcError(null, "initialize needs an id.", -32600);
      if (request.sessionId !== undefined) live?.close("the harness initialized again");
      return this.initialize(request, fingerprint, message.id, message);
    }
    // Spec: a request for an unknown or ended session gets 404 and the client initializes again.
    if (live === undefined) return empty(request.sessionId === undefined ? 400 : 404);
    live.touch();
    if (typeof message.method === "string" && isId(message.id)) {
      return live.request(message.id, message, true);
    }
    // Notifications and the client's answers to server requests.
    await live.notify(message);
    return empty(202);
  }

  private async initialize(
    request: StdioBridgeRequest,
    fingerprint: string,
    id: JsonRpcId,
    message: unknown,
  ): Promise<StdioBridgeResponse> {
    if (!this.makeRoom(request.serverId)) {
      return rpcError(
        id,
        "Too many MCP server processes are busy right now. Try again when a running call finishes.",
      );
    }
    const inherited: Record<string, string> = {};
    for (const name of this.options.inheritEnv) {
      const value = process.env[name];
      if (value !== undefined) inherited[name] = value;
    }
    let child: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      child = NodeChildProcess.spawn(request.server.command, [...request.server.args], {
        env: { ...inherited, ...request.server.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return rpcError(id, `Could not start the MCP server: ${String(error)}`);
    }
    const session = new StdioSession(
      request.serverId,
      request.owner,
      fingerprint,
      child,
      this.options,
      (closed, reason) => {
        this.sessions.delete(closed.id);
        this.log("stdio MCP session closed", {
          serverId: closed.serverId,
          reason,
          ...(closed.stderrTail.length > 0 ? { stderrTail: closed.stderrTail.slice(-2048) } : {}),
        });
      },
    );
    this.sessions.set(session.id, session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.options.initializeTimeoutMs);
    });
    const answered = await Promise.race([session.request(id, message, false), timedOut]);
    clearTimeout(timer);
    if (answered === "timeout") {
      session.close("it did not answer initialize in time");
      return rpcError(
        id,
        `The MCP server did not answer initialize within ${this.options.initializeTimeoutMs / 1000}s.`,
      );
    }
    const parsed = JSON.parse(answered.body) as Envelope;
    if (parsed.error !== undefined || session.closed) {
      session.close("initialize failed");
      return answered;
    }
    session.markInitialized();
    return { ...answered, headers: { ...answered.headers, "mcp-session-id": session.id } };
  }

  /**
   * Keeps a runaway harness from spawning without bound: idle sessions go, least recently used
   * first; a session with a call in flight is never cut. False when no idle session can make room.
   */
  private makeRoom(serverId: string): boolean {
    const forServer = () =>
      [...this.sessions.values()].filter((session) => session.serverId === serverId).length;
    const idle = (onlyThisServer: boolean) =>
      [...this.sessions.values()]
        .filter((session) => !session.busy && (!onlyThisServer || session.serverId === serverId))
        .toSorted((a, b) => a.lastUsed - b.lastUsed);
    for (const session of idle(true)) {
      if (forServer() < this.options.maxSessionsPerServer) break;
      session.close("too many sessions were open for this server");
    }
    for (const session of idle(false)) {
      if (this.sessions.size < this.options.maxSessions) break;
      session.close("too many MCP server processes were open");
    }
    return (
      forServer() < this.options.maxSessionsPerServer &&
      this.sessions.size < this.options.maxSessions
    );
  }
}

export class StdioMcpBridge extends Context.Service<
  StdioMcpBridge,
  {
    readonly handle: (request: StdioBridgeRequest) => Effect.Effect<StdioBridgeResponse>;
    readonly closeServer: (serverId: string, reason: string) => Effect.Effect<void>;
  }
>()("t3/mcp/StdioMcpBridge") {}

export const make = Effect.fn("StdioMcpBridge.make")(function* (options?: StdioMcpBridgeOptions) {
  const core = new StdioMcpBridgeCore(options, (message, details) => {
    Effect.runFork(Effect.logInfo(message, details));
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => core.closeAll()));
  return StdioMcpBridge.of({
    handle: (request) => Effect.promise(() => core.handle(request)),
    closeServer: (serverId, reason) => Effect.sync(() => core.closeServer(serverId, reason)),
  });
});

export const layer = Layer.effect(StdioMcpBridge, make());

export type StdioTestResult =
  | {
      readonly _tag: "Connected";
      readonly serverName?: string;
      readonly tools: ReadonlyArray<string>;
    }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Unreachable"; readonly timedOut: boolean };

/** The settings Test button for a stdio entry: one throwaway process, initialize then tools/list. */
export const testStdioServer = async (
  server: StdioBridgeRequest["server"],
  timeoutMs = 10_000,
): Promise<StdioTestResult> => {
  const core = new StdioMcpBridgeCore({ initializeTimeoutMs: timeoutMs, maxSessionsPerServer: 1 });
  const base = { serverId: "test", server, owner: "settings-test" } as const;
  const post = (sessionId: string | undefined, message: unknown) =>
    core.handle({ ...base, method: "POST", sessionId, body: JSON.stringify(message) });
  try {
    const initialized = await post(undefined, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t3-code-settings", version: "1" },
      },
    });
    const init = JSON.parse(initialized.body) as Envelope & {
      readonly result?: { readonly serverInfo?: { readonly name?: unknown } };
      readonly error?: { readonly message?: unknown };
    };
    const sessionId = initialized.headers["mcp-session-id"];
    if (sessionId === undefined || init.error !== undefined) {
      const message = typeof init.error?.message === "string" ? init.error.message : "";
      return message.includes("did not answer initialize")
        ? { _tag: "Unreachable", timedOut: true }
        : { _tag: "Failed", message: message || "The process did not answer like an MCP server." };
    }
    await post(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listed = await Promise.race([
      post(sessionId, { jsonrpc: "2.0", id: 1, method: "tools/list" }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (listed === undefined) return { _tag: "Unreachable", timedOut: true };
    const tools = (JSON.parse(listed.body) as { result?: { tools?: unknown } }).result?.tools;
    if (!Array.isArray(tools))
      return { _tag: "Failed", message: "The server did not list its tools." };
    const name = init.result?.serverInfo?.name;
    return {
      _tag: "Connected",
      ...(typeof name === "string" ? { serverName: name } : {}),
      tools: tools.flatMap((tool: { name?: unknown }) =>
        typeof tool?.name === "string" ? [tool.name] : [],
      ),
    };
  } finally {
    core.closeAll("the test finished");
  }
};
