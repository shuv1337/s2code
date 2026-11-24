// Relays JSON-RPC verbatim between the shared-server proxy and local processes; schema decoding would reject foreign payloads.
// A process-lifecycle core in plain Node, wrapped by a small Effect service at the end.
// @effect-diagnostics globalJsonInEffect:off nodeBuiltinImport:off globalDate:off globalTimers:off effectFnOpportunity:off runEffectInsideEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import {
  isStdioMcpServer,
  type McpServerStdioConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
  /** A stdout line longer than this in UTF-8 bytes closes the session instead of growing the buffer. */
  readonly maxMessageBytes?: number;
  readonly idleTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly killGraceMs?: number;
  /** Variables the child inherits from this server; everything else comes from the entry's env. */
  readonly inheritEnv?: ReadonlyArray<string>;
  readonly platform?: NodeJS.Platform;
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

interface CloseDetails {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly errorCode?: string;
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

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;

const signalProcessTree = (
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Process group may already be gone; fall back to the direct child handle.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
};

/** The binding a session was spawned for; a settings edit retires sessions that no longer match it. */
const stdioServerFingerprint = (server: StdioBridgeRequest["server"]) =>
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
  private frameChunks: Buffer[] = [];
  private frameBytes = 0;
  private initialized = false;
  private readonly waiting: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveProcessEnd!: () => void;
  readonly processExited: Promise<void>;
  processEnded = false;
  lastUsed = Date.now();
  closed = false;
  closeReason: string | undefined;

  readonly serverId: string;
  readonly owner: string;
  readonly fingerprint: string;
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly options: Required<StdioMcpBridgeOptions>;
  private readonly onClose: (session: StdioSession, reason: string, details?: CloseDetails) => void;
  private readonly onProcessEnd: (session: StdioSession) => void;

  constructor(
    serverId: string,
    owner: string,
    fingerprint: string,
    child: NodeChildProcess.ChildProcessWithoutNullStreams,
    options: Required<StdioMcpBridgeOptions>,
    onClose: (session: StdioSession, reason: string, details?: CloseDetails) => void,
    onProcessEnd: (session: StdioSession) => void,
  ) {
    this.serverId = serverId;
    this.owner = owner;
    this.fingerprint = fingerprint;
    this.child = child;
    this.options = options;
    this.onClose = onClose;
    this.onProcessEnd = onProcessEnd;
    this.processExited = new Promise<void>((resolve) => {
      this.resolveProcessEnd = resolve;
    });
    child.stdout.on("data", (chunk: Buffer | string) =>
      this.read(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk),
    );
    // Drain stderr without retaining it so a noisy child never fills its pipe buffer or leaks secrets to logs.
    child.stderr.resume();
    child.stdin.on("error", () => this.close("its stdin closed"));
    child.on("error", (error) => {
      this.markProcessEnded();
      const errorCode = errnoCode(error);
      this.close("it could not start", errorCode !== undefined ? { errorCode } : undefined);
    });
    child.on("exit", (code, signal) => {
      this.markProcessEnded();
      this.close(`it exited (${signal ?? `code ${code ?? "unknown"}`})`, {
        ...(code !== null ? { exitCode: code } : {}),
        ...(signal !== null ? { signal } : {}),
      });
    });
    this.touch();
  }

  private markProcessEnded() {
    if (this.processEnded) return;
    this.processEnded = true;
    clearTimeout(this.forceKillTimer);
    this.forceKillTimer = undefined;
    this.onProcessEnd(this);
    this.resolveProcessEnd();
  }

  touch() {
    if (this.closed) return;
    this.lastUsed = Date.now();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => (this.busy ? this.touch() : this.close("it was idle")),
      this.options.idleTimeoutMs,
    );
    this.idleTimer.unref?.();
  }

  /** A request is waiting on it, initialize included, so evicting it would cut a call short. */
  get busy() {
    return this.pending.size > 0;
  }

  private read(chunk: Buffer) {
    if (this.closed || chunk.length === 0) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        const part = start === 0 ? chunk : chunk.subarray(start);
        this.frameBytes += part.length;
        if (this.frameBytes > this.options.maxMessageBytes) {
          this.frameChunks = [];
          this.frameBytes = 0;
          this.close(`it sent a message over ${this.options.maxMessageBytes} bytes`);
          return;
        }
        this.frameChunks.push(part);
        return;
      }
      const part = chunk.subarray(start, newline);
      const totalBytes = this.frameBytes + part.length;
      if (totalBytes > this.options.maxMessageBytes) {
        this.frameChunks = [];
        this.frameBytes = 0;
        this.close(`it sent a message over ${this.options.maxMessageBytes} bytes`);
        return;
      }
      const lineBuffer =
        this.frameChunks.length === 0
          ? part
          : Buffer.concat([...this.frameChunks, part], totalBytes);
      this.frameChunks = [];
      this.frameBytes = 0;
      start = newline + 1;
      const line = lineBuffer.toString("utf8").trim();
      if (line.length > 0) {
        this.receive(line);
        if (this.closed) return;
      }
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
      if (isId(message.id)) {
        if (message.method === "ping") {
          this.write({ jsonrpc: "2.0", id: message.id, result: {} });
        } else {
          // No GET stream, so server-initiated requests (sampling, elicitation, roots) can't reach the harness.
          this.write({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Not supported through T3 Code's shared MCP bridge." },
          });
        }
      }
      return;
    }
    if (!isId(message.id)) return;
    const key = idKey(message.id);
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    this.touch();
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

  request(
    id: JsonRpcId,
    message: unknown,
    gated: boolean,
    signal?: AbortSignal,
  ): Promise<StdioBridgeResponse> {
    if (this.closed) return Promise.resolve(rpcError(id, "The MCP server process is closed."));
    if (signal?.aborted) return Promise.resolve(rpcError(id, "The request was cancelled."));
    const key = idKey(id);
    if (this.pending.has(key))
      return Promise.resolve(rpcError(id, "Duplicate request id.", -32600));
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this.pending.delete(key)) return;
        if (!this.closed && !this.busy) this.touch();
        settle(rpcError(id, "The request was cancelled."));
      };
      const settle = (response: StdioBridgeResponse) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(key, { resolve: settle });
      const send = () => {
        if (this.closed || signal?.aborted || !this.pending.has(key)) return;
        this.write(message);
      };
      if (gated) void this.ready().then(send);
      else send();
    });
  }

  async notify(message: unknown, signal?: AbortSignal): Promise<void> {
    await this.ready();
    if (signal?.aborted) return;
    this.write(message);
  }

  terminate() {
    if (this.processEnded) return;
    signalProcessTree(this.child, "SIGTERM", this.options.platform);
  }

  close(reason: string, details?: CloseDetails) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    clearTimeout(this.idleTimer);
    this.frameChunks = [];
    this.frameBytes = 0;
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
    this.onClose(this, reason, details);
    if (!this.processEnded && this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.stdin.end();
      } catch {
        // Stdin may already be ended or broken.
      }
      signalProcessTree(this.child, "SIGTERM", this.options.platform);
      this.forceKillTimer = setTimeout(() => {
        this.forceKillTimer = undefined;
        signalProcessTree(this.child, "SIGKILL", this.options.platform);
      }, this.options.killGraceMs);
      this.forceKillTimer.unref?.();
    }
  }
}

/**
 * Serves stdio MCP servers on the shared proxy route. Each harness session gets its own child,
 * started on initialize and stopped on DELETE, idle, crash, a settings change or shutdown. A lost
 * session answers 404 so the harness initializes again; nothing is replayed.
 */
export class StdioMcpBridgeCore {
  private readonly sessions = new Map<string, StdioSession>();
  private readonly retiring = new Set<StdioSession>();
  private readonly reserving: string[] = [];
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
      maxMessageBytes: options.maxMessageBytes ?? 8 * 1024 * 1024,
      idleTimeoutMs: options.idleTimeoutMs ?? 10 * 60_000,
      initializeTimeoutMs: options.initializeTimeoutMs ?? 10_000,
      killGraceMs: options.killGraceMs ?? 2_000,
      inheritEnv: options.inheritEnv ?? DEFAULT_INHERITED_ENV,
      platform: options.platform ?? HostProcess.Platform.defaultValue(),
    };
  }

  get sessionCount() {
    return this.sessions.size;
  }

  get retiringCount() {
    return this.retiring.size;
  }

  /** Live child pids, for tests and diagnostics. */
  pids(serverId?: string): ReadonlyArray<number> {
    return [...this.sessions.values()]
      .filter((session) => serverId === undefined || session.serverId === serverId)
      .flatMap((session) => (session.child.pid === undefined ? [] : [session.child.pid]));
  }

  closeAll(reason = "T3 Code stopped") {
    for (const session of this.sessions.values()) session.close(reason);
    for (const session of this.retiring) session.terminate();
  }

  /** Stops every session of a server, e.g. after it is removed or disabled. */
  closeServer(serverId: string, reason: string) {
    for (const session of this.sessions.values()) {
      if (session.serverId === serverId) session.close(reason);
    }
  }

  /** Stops only active sessions whose server was removed, disabled, non-stdio, or changed fingerprint. */
  reconcile(mcpServers: ServerSettings["mcpServers"], reason?: string) {
    for (const session of this.sessions.values()) {
      const entry = Object.hasOwn(mcpServers, session.serverId)
        ? mcpServers[session.serverId as keyof ServerSettings["mcpServers"]]
        : undefined;
      let staleReason: string | undefined;
      if (entry === undefined) staleReason = reason ?? "it was removed in Settings";
      else if (!isStdioMcpServer(entry))
        staleReason = reason ?? "it is no longer a local process in Settings";
      else if (!entry.enabled) staleReason = reason ?? "it was turned off in Settings";
      else if (stdioServerFingerprint(entry) !== session.fingerprint)
        staleReason = reason ?? "its settings changed";
      if (staleReason !== undefined) session.close(staleReason);
    }
  }

  async handle(request: StdioBridgeRequest, signal?: AbortSignal): Promise<StdioBridgeResponse> {
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
      return this.initialize(request, fingerprint, message.id, message, signal);
    }
    // Spec: a request for an unknown or ended session gets 404 and the client initializes again.
    if (live === undefined) return empty(request.sessionId === undefined ? 400 : 404);
    if (Object.hasOwn(message, "id") && message.id !== undefined && !isId(message.id)) {
      return rpcError(null, "Invalid Request.", -32600);
    }
    live.touch();
    if (typeof message.method === "string" && isId(message.id)) {
      return live.request(message.id, message, true, signal);
    }
    // Notifications and the client's answers to server requests.
    await live.notify(message, signal);
    return empty(202);
  }

  private async initialize(
    request: StdioBridgeRequest,
    fingerprint: string,
    id: JsonRpcId,
    message: unknown,
    signal?: AbortSignal,
  ): Promise<StdioBridgeResponse> {
    if (signal?.aborted) return rpcError(id, "The request was cancelled.");
    const deadline = Date.now() + this.options.initializeTimeoutMs;
    const room = await this.reserveRoom(request.serverId, deadline, signal);
    if (room === "aborted") return rpcError(id, "The request was cancelled.");
    if (room === "timeout") {
      return rpcError(
        id,
        `The MCP server did not answer initialize within ${this.options.initializeTimeoutMs / 1000}s.`,
      );
    }
    if (room === "busy") {
      return rpcError(
        id,
        "Too many MCP server processes are busy right now. Try again when a running call finishes.",
      );
    }
    let session: StdioSession;
    try {
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
          ...(this.options.platform !== "win32" ? { detached: true } : {}),
        });
      } catch (error) {
        const errorCode = errnoCode(error);
        this.log("stdio MCP server failed to start", {
          serverId: request.serverId,
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
        return rpcError(id, "The MCP server process could not start.");
      }
      session = new StdioSession(
        request.serverId,
        request.owner,
        fingerprint,
        child,
        this.options,
        (closed, reason, details) => {
          this.sessions.delete(closed.id);
          if (!closed.processEnded) this.retiring.add(closed);
          this.log("stdio MCP session closed", {
            serverId: closed.serverId,
            reason,
            ...(details?.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
            ...(details?.signal !== undefined ? { signal: details.signal } : {}),
            ...(details?.errorCode !== undefined ? { errorCode: details.errorCode } : {}),
          });
        },
        (ended) => {
          this.retiring.delete(ended);
        },
      );
      this.sessions.set(session.id, session);
    } finally {
      const index = this.reserving.indexOf(request.serverId);
      if (index !== -1) this.reserving.splice(index, 1);
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remainingMs);
    });
    const answered = await Promise.race([session.request(id, message, false, signal), timedOut]);
    clearTimeout(timer);
    if (answered === "timeout") {
      session.close("it did not answer initialize in time");
      return rpcError(
        id,
        `The MCP server did not answer initialize within ${this.options.initializeTimeoutMs / 1000}s.`,
      );
    }
    if (signal?.aborted) {
      session.close("the request was cancelled");
      return rpcError(id, "The request was cancelled.");
    }
    const parsed = JSON.parse(answered.body) as Envelope;
    if (parsed.error !== undefined || session.closed) {
      session.close("initialize failed");
      return parsed.error !== undefined
        ? answered
        : rpcError(
            id,
            `The MCP server process stopped before answering: ${session.closeReason ?? "initialize failed"}.`,
          );
    }
    session.markInitialized();
    return { ...answered, headers: { ...answered.headers, "mcp-session-id": session.id } };
  }

  private countForServer(serverId: string) {
    let count = 0;
    for (const session of this.sessions.values()) if (session.serverId === serverId) count++;
    for (const session of this.retiring) if (session.serverId === serverId) count++;
    for (const id of this.reserving) if (id === serverId) count++;
    return count;
  }

  private countTotal() {
    return this.sessions.size + this.retiring.size + this.reserving.length;
  }

  private waitForAnyExit(
    sessions: ReadonlyArray<StdioSession>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<"exited" | "timeout" | "aborted"> {
    if (signal?.aborted) return Promise.resolve("aborted");
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: "exited" | "timeout" | "aborted") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => done("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => done("timeout"), remainingMs);
      timer.unref?.();
      for (const session of sessions) {
        void session.processExited.then(() => done("exited"));
      }
    });
  }

  /**
   * Keeps a runaway harness from spawning without bound: idle sessions go, least recently used
   * first; a session with a call in flight is never cut; retiring children count until they exit.
   */
  private async reserveRoom(
    serverId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<"reserved" | "busy" | "timeout" | "aborted"> {
    while (true) {
      if (signal?.aborted) return "aborted";
      const forServer = this.countForServer(serverId);
      const total = this.countTotal();
      if (forServer < this.options.maxSessionsPerServer && total < this.options.maxSessions) {
        this.reserving.push(serverId);
        return "reserved";
      }
      const idle = (onlyThisServer: boolean) =>
        [...this.sessions.values()]
          .filter((session) => !session.busy && (!onlyThisServer || session.serverId === serverId))
          .toSorted((a, b) => a.lastUsed - b.lastUsed);
      let evicted = false;
      if (forServer >= this.options.maxSessionsPerServer) {
        const candidate = idle(true)[0];
        if (candidate !== undefined) {
          candidate.close("too many sessions were open for this server");
          evicted = true;
        }
      }
      if (!evicted && total >= this.options.maxSessions) {
        const candidate = idle(false)[0];
        if (candidate !== undefined) {
          candidate.close("too many MCP server processes were open");
          evicted = true;
        }
      }
      if (
        this.countForServer(serverId) < this.options.maxSessionsPerServer &&
        this.countTotal() < this.options.maxSessions
      ) {
        continue;
      }
      const relevantRetiring =
        this.countForServer(serverId) >= this.options.maxSessionsPerServer
          ? [...this.retiring].filter((session) => session.serverId === serverId)
          : [...this.retiring];
      if (relevantRetiring.length === 0) return "busy";
      const waited = await this.waitForAnyExit(relevantRetiring, deadline, signal);
      if (waited !== "exited") return waited;
    }
  }
}

export class StdioMcpBridge extends Context.Service<
  StdioMcpBridge,
  {
    readonly handle: (request: StdioBridgeRequest) => Effect.Effect<StdioBridgeResponse>;
    readonly closeServer: (serverId: string, reason: string) => Effect.Effect<void>;
    readonly reconcile: (
      mcpServers: ServerSettings["mcpServers"],
      reason?: string,
    ) => Effect.Effect<void>;
  }
>()("t3/mcp/StdioMcpBridge") {}

export const make = Effect.fn("StdioMcpBridge.make")(function* (options?: StdioMcpBridgeOptions) {
  const platform = yield* HostProcess.Platform;
  const services = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(services);
  const core = new StdioMcpBridgeCore({ platform, ...options }, (message, details) => {
    runFork(Effect.logInfo(message, details));
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => core.closeAll()));
  return StdioMcpBridge.of({
    handle: (request) => Effect.promise((signal) => core.handle(request, signal)),
    closeServer: (serverId, reason) => Effect.sync(() => core.closeServer(serverId, reason)),
    reconcile: (mcpServers, reason) => Effect.sync(() => core.reconcile(mcpServers, reason)),
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
