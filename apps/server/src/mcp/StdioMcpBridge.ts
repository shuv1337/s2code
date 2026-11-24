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
  readonly params?: unknown;
  readonly requestId?: unknown;
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

const isProcessGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
};

const signalProcessTree = (
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
) => {
  if (platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Process group may already be gone; fall back to the direct child handle if still running.
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
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

const staleServerReason = (
  mcpServers: ServerSettings["mcpServers"],
  serverId: string,
  fingerprint: string,
  reason?: string,
): string | undefined => {
  const entry = Object.hasOwn(mcpServers, serverId)
    ? mcpServers[serverId as keyof ServerSettings["mcpServers"]]
    : undefined;
  if (entry === undefined) return reason ?? "it was removed in Settings";
  if (!isStdioMcpServer(entry)) return reason ?? "it is no longer a local process in Settings";
  if (!entry.enabled) return reason ?? "it was turned off in Settings";
  if (stdioServerFingerprint(entry) !== fingerprint) return reason ?? "its settings changed";
  return undefined;
};

const skipWs = (s: string, i: number): number => {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
    else break;
  }
  return i;
};

const skipString = (s: string, i: number): number => {
  i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) i += 2;
    else if (c === 0x22) return i + 1;
    else i++;
  }
  return i;
};

const skipValue = (s: string, i: number): number => {
  if (i >= s.length) return i;
  const c = s.charCodeAt(i);
  if (c === 0x22) return skipString(s, i);
  if (c === 0x7b || c === 0x5b) {
    let depth = 1;
    i++;
    while (i < s.length && depth > 0) {
      const ch = s.charCodeAt(i);
      if (ch === 0x22) i = skipString(s, i);
      else if (ch === 0x7b || ch === 0x5b) {
        depth++;
        i++;
      } else if (ch === 0x7d || ch === 0x5d) {
        depth--;
        i++;
      } else {
        i++;
      }
    }
    return i;
  }
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (
      ch === 0x2c ||
      ch === 0x7d ||
      ch === 0x5d ||
      ch === 0x20 ||
      ch === 0x09 ||
      ch === 0x0a ||
      ch === 0x0d
    ) {
      break;
    }
    i++;
  }
  return i;
};

/** Returns the `[start, end)` span of the last top-level property matching `keyName` in a JSON object string. */
const findLastObjectKeySpan = (
  source: string,
  keyName: string,
): readonly [number, number] | undefined => {
  const literalKey = JSON.stringify(keyName);
  let i = skipWs(source, 0);
  if (source.charCodeAt(i) !== 0x7b) return undefined;
  i = skipWs(source, i + 1);
  let match: readonly [number, number] | undefined;
  while (i < source.length && source.charCodeAt(i) !== 0x7d) {
    if (source.charCodeAt(i) !== 0x22) break;
    const keyStart = i;
    const keyEnd = skipString(source, i);
    i = skipWs(source, keyEnd);
    if (source.charCodeAt(i) !== 0x3a) break;
    const valueStart = skipWs(source, i + 1);
    const valueEnd = skipValue(source, valueStart);
    const rawKey = source.slice(keyStart, keyEnd);
    if (rawKey === literalKey || (rawKey.includes("\\") && JSON.parse(rawKey) === keyName)) {
      match = [valueStart, valueEnd];
    }
    i = skipWs(source, valueEnd);
    if (source.charCodeAt(i) === 0x2c) i = skipWs(source, i + 1);
    else break;
  }
  return match;
};

/** Replaces only the last top-level `"id"` value span so unrelated payload values (e.g. 64-bit ints) stay verbatim. */
const replaceTopLevelJsonId = (line: string, callerId: JsonRpcId, fallback: Envelope): string => {
  const span = findLastObjectKeySpan(line, "id");
  return span === undefined
    ? JSON.stringify({ ...fallback, id: callerId })
    : line.slice(0, span[0]) + JSON.stringify(callerId) + line.slice(span[1]);
};

const isLosslessJsonNumber = (rawToken: string, parsed: number): boolean => {
  if (!Number.isFinite(parsed)) return false;
  if (/^-?\d+$/.test(rawToken)) {
    try {
      return BigInt(rawToken) === BigInt(parsed);
    } catch {
      return false;
    }
  }
  return Math.abs(parsed) <= Number.MAX_SAFE_INTEGER;
};

const hasLossyNumericKey = (source: string, keyName: string, parsedValue: unknown): boolean => {
  if (typeof parsedValue !== "number") return false;
  const span = findLastObjectKeySpan(source, keyName);
  if (span === undefined) return false;
  return !isLosslessJsonNumber(source.slice(span[0], span[1]), parsedValue);
};

interface Pending {
  readonly callerId: JsonRpcId;
  readonly callerKey: string;
  readonly resolve: (response: StdioBridgeResponse) => void;
}

interface RoomWaiter {
  readonly serverId: string;
  readonly fingerprint: string;
  invalidatedReason: string | undefined;
  readonly wake: () => void;
}

interface RoomReservation {
  readonly serverId: string;
  readonly fingerprint: string;
  invalidatedReason: string | undefined;
}

const MAX_RECENTLY_ABORTED_IDS = 256;

class StdioSession {
  readonly id = NodeCrypto.randomUUID();
  private nextWireId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly callerToWireId = new Map<string, number>();
  private readonly abortedCallerToWireId = new Map<string, number>();
  private readonly abortedWireToCallerKey = new Map<number, string>();
  private frameChunks: Buffer[] = [];
  private frameBytes = 0;
  private initialized = false;
  private readonly waiting: Array<() => void> = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveProcessEnd!: () => void;
  readonly processExited: Promise<void>;
  private childExited = false;
  private forceKillSent = false;
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
      this.childExited = true;
      this.markProcessEnded();
      const errorCode = errnoCode(error);
      this.close("it could not start", errorCode !== undefined ? { errorCode } : undefined);
    });
    child.on("exit", (code, signal) => {
      this.childExited = true;
      const groupAlive =
        !this.forceKillSent &&
        this.options.platform !== "win32" &&
        this.child.pid !== undefined &&
        isProcessGroupAlive(this.child.pid);
      if (!groupAlive) {
        this.markProcessEnded();
      }
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
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      const abortedKey = this.abortedWireToCallerKey.get(message.id);
      if (abortedKey !== undefined) {
        this.abortedWireToCallerKey.delete(message.id);
        if (this.abortedCallerToWireId.get(abortedKey) === message.id) {
          this.abortedCallerToWireId.delete(abortedKey);
        }
      }
      return;
    }
    this.pending.delete(message.id);
    this.callerToWireId.delete(pending.callerKey);
    this.touch();
    pending.resolve({
      status: 200,
      headers: { "content-type": "application/json" },
      body: replaceTopLevelJsonId(line, pending.callerId, message),
    });
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

  private clearAbortedCaller(callerKey: string) {
    const oldWireId = this.abortedCallerToWireId.get(callerKey);
    if (oldWireId !== undefined) {
      this.abortedCallerToWireId.delete(callerKey);
      this.abortedWireToCallerKey.delete(oldWireId);
    }
  }

  private rememberAborted(callerKey: string, wireId: number) {
    this.clearAbortedCaller(callerKey);
    if (this.abortedWireToCallerKey.size >= MAX_RECENTLY_ABORTED_IDS) {
      const oldestWireId = this.abortedWireToCallerKey.keys().next().value;
      if (oldestWireId !== undefined) {
        const oldestKey = this.abortedWireToCallerKey.get(oldestWireId);
        this.abortedWireToCallerKey.delete(oldestWireId);
        if (oldestKey !== undefined && this.abortedCallerToWireId.get(oldestKey) === oldestWireId) {
          this.abortedCallerToWireId.delete(oldestKey);
        }
      }
    }
    this.abortedCallerToWireId.set(callerKey, wireId);
    this.abortedWireToCallerKey.set(wireId, callerKey);
  }

  request(
    id: JsonRpcId,
    message: Envelope,
    gated: boolean,
    signal?: AbortSignal,
  ): Promise<StdioBridgeResponse> {
    if (this.closed) return Promise.resolve(rpcError(id, "The MCP server process is closed."));
    if (signal?.aborted) return Promise.resolve(rpcError(id, "The request was cancelled."));
    const callerKey = idKey(id);
    if (this.callerToWireId.has(callerKey))
      return Promise.resolve(rpcError(id, "Duplicate request id.", -32600));
    this.clearAbortedCaller(callerKey);
    const wireId = this.nextWireId++;
    const wireMessage = { ...message, id: wireId };
    return new Promise((resolve) => {
      let sent = false;
      const onAbort = () => {
        if (!this.pending.delete(wireId)) return;
        this.callerToWireId.delete(callerKey);
        if (sent) this.rememberAborted(callerKey, wireId);
        if (!this.closed && !this.busy) this.touch();
        settle(rpcError(id, "The request was cancelled."));
      };
      const settle = (response: StdioBridgeResponse) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(wireId, { callerId: id, callerKey, resolve: settle });
      this.callerToWireId.set(callerKey, wireId);
      const send = () => {
        if (this.closed || signal?.aborted || !this.pending.has(wireId)) return;
        sent = this.write(wireMessage);
      };
      if (gated) void this.ready().then(send);
      else send();
    });
  }

  async notify(message: unknown, signal?: AbortSignal): Promise<void> {
    let outbound = message;
    if (isRecord(message) && message.method === "notifications/cancelled") {
      if (!isRecord(message.params) || !isId(message.params.requestId)) return;
      // Resolve the wire ID synchronously before awaiting readiness so a reused caller ID cannot be targeted later.
      const callerKey = idKey(message.params.requestId);
      const wireId =
        this.callerToWireId.get(callerKey) ?? this.abortedCallerToWireId.get(callerKey);
      // Never forward an unmapped caller ID that could match a different concurrent wire ID.
      if (wireId === undefined) return;
      outbound = { ...message, params: { ...message.params, requestId: wireId } };
    }
    await this.ready();
    if (signal?.aborted) return;
    this.write(outbound);
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
    for (const pending of this.pending.values()) {
      pending.resolve(
        rpcError(pending.callerId, `The MCP server process stopped before answering: ${reason}.`),
      );
    }
    this.pending.clear();
    this.callerToWireId.clear();
    this.abortedCallerToWireId.clear();
    this.abortedWireToCallerKey.clear();
    this.onClose(this, reason, details);
    if (!this.processEnded) {
      if (!this.childExited) {
        try {
          this.child.stdin.end();
        } catch {
          // Stdin may already be ended or broken.
        }
      }
      signalProcessTree(this.child, "SIGTERM", this.options.platform);
      this.forceKillTimer = setTimeout(() => {
        this.forceKillTimer = undefined;
        this.forceKillSent = true;
        signalProcessTree(this.child, "SIGKILL", this.options.platform);
        if (this.childExited) this.markProcessEnded();
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
  private readonly reservations = new Set<RoomReservation>();
  private readonly waiters = new Set<RoomWaiter>();
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
    for (const waiter of this.waiters) {
      waiter.invalidatedReason = reason;
      waiter.wake();
    }
    for (const reservation of this.reservations) {
      reservation.invalidatedReason = reason;
    }
    for (const session of this.sessions.values()) session.close(reason);
    for (const session of this.retiring) session.terminate();
  }

  /** Stops every session of a server, e.g. after it is removed or disabled. */
  closeServer(serverId: string, reason: string) {
    for (const waiter of this.waiters) {
      if (waiter.serverId === serverId) {
        waiter.invalidatedReason = reason;
        waiter.wake();
      }
    }
    for (const reservation of this.reservations) {
      if (reservation.serverId === serverId) {
        reservation.invalidatedReason = reason;
      }
    }
    for (const session of this.sessions.values()) {
      if (session.serverId === serverId) session.close(reason);
    }
  }

  /** Stops only active sessions and queued initializations whose server was removed, disabled, non-stdio, or changed fingerprint. */
  reconcile(mcpServers: ServerSettings["mcpServers"], reason?: string) {
    for (const waiter of this.waiters) {
      const staleReason = staleServerReason(
        mcpServers,
        waiter.serverId,
        waiter.fingerprint,
        reason,
      );
      if (staleReason !== undefined) {
        waiter.invalidatedReason = staleReason;
        waiter.wake();
      }
    }
    for (const reservation of this.reservations) {
      const staleReason = staleServerReason(
        mcpServers,
        reservation.serverId,
        reservation.fingerprint,
        reason,
      );
      if (staleReason !== undefined) {
        reservation.invalidatedReason = staleReason;
      }
    }
    for (const session of this.sessions.values()) {
      const staleReason = staleServerReason(
        mcpServers,
        session.serverId,
        session.fingerprint,
        reason,
      );
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
      if (!isId(message.id) || hasLossyNumericKey(request.body, "id", message.id)) {
        return rpcError(null, "initialize needs an id.", -32600);
      }
      if (request.sessionId !== undefined) live?.close("the harness initialized again");
      return this.initialize(request, fingerprint, message.id, message, signal);
    }
    // Spec: a request for an unknown or ended session gets 404 and the client initializes again.
    if (live === undefined) return empty(request.sessionId === undefined ? 400 : 404);
    if (
      Object.hasOwn(message, "id") &&
      message.id !== undefined &&
      (!isId(message.id) || hasLossyNumericKey(request.body, "id", message.id))
    ) {
      return rpcError(null, "Invalid Request.", -32600);
    }
    live.touch();
    if (typeof message.method === "string" && isId(message.id)) {
      return live.request(message.id, message, true, signal);
    }
    if (
      message.method === "notifications/cancelled" &&
      isRecord(message.params) &&
      typeof message.params.requestId === "number"
    ) {
      const paramsSpan = findLastObjectKeySpan(request.body, "params");
      if (
        paramsSpan !== undefined &&
        hasLossyNumericKey(
          request.body.slice(paramsSpan[0], paramsSpan[1]),
          "requestId",
          message.params.requestId,
        )
      ) {
        return empty(202);
      }
    }
    // Notifications and the client's answers to server requests.
    await live.notify(message, signal);
    return empty(202);
  }

  private async initialize(
    request: StdioBridgeRequest,
    fingerprint: string,
    id: JsonRpcId,
    message: Envelope,
    signal?: AbortSignal,
  ): Promise<StdioBridgeResponse> {
    if (signal?.aborted) return rpcError(id, "The request was cancelled.");
    const deadline = Date.now() + this.options.initializeTimeoutMs;
    const room = await this.reserveRoom(request.serverId, fingerprint, deadline, signal);
    if (room.status === "aborted") return rpcError(id, "The request was cancelled.");
    if (room.status === "invalidated") {
      return rpcError(id, `The MCP server process stopped before answering: ${room.reason}.`);
    }
    if (room.status === "timeout") {
      return rpcError(
        id,
        `The MCP server did not answer initialize within ${this.options.initializeTimeoutMs / 1000}s.`,
      );
    }
    if (room.status === "busy") {
      return rpcError(
        id,
        "Too many MCP server processes are busy right now. Try again when a running call finishes.",
      );
    }
    const { reservation } = room;
    let session: StdioSession;
    try {
      if (reservation.invalidatedReason !== undefined) {
        return rpcError(
          id,
          `The MCP server process stopped before answering: ${reservation.invalidatedReason}.`,
        );
      }
      if (signal?.aborted) return rpcError(id, "The request was cancelled.");
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
      this.reservations.delete(reservation);
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

  private countActiveForServer(serverId: string) {
    let count = 0;
    for (const session of this.sessions.values()) if (session.serverId === serverId) count++;
    for (const reservation of this.reservations) if (reservation.serverId === serverId) count++;
    return count;
  }

  private countRetiringForServer(serverId: string) {
    let count = 0;
    for (const session of this.retiring) if (session.serverId === serverId) count++;
    return count;
  }

  private countActiveTotal() {
    return this.sessions.size + this.reservations.size;
  }

  private waitForAnyExit(
    sessions: ReadonlyArray<StdioSession>,
    deadline: number,
    signal: AbortSignal | undefined,
    onWakeReady: (wake: () => void) => void,
  ): Promise<"exited" | "timeout" | "aborted" | "woken"> {
    if (signal?.aborted) return Promise.resolve("aborted");
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: "exited" | "timeout" | "aborted" | "woken") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      onWakeReady(() => done("woken"));
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
   * Keeps a runaway harness from spawning without bound: retiring children count until they exit
   * and are waited on before evicting healthy idle sessions; active idle sessions go LRU only when
   * active counts alone hit a cap; a session with a call in flight is never cut.
   */
  private async reserveRoom(
    serverId: string,
    fingerprint: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "reserved"; readonly reservation: RoomReservation }
    | { readonly status: "busy" }
    | { readonly status: "timeout" }
    | { readonly status: "aborted" }
    | { readonly status: "invalidated"; readonly reason: string }
  > {
    let wakeWaiter: (() => void) | undefined;
    const waiter: RoomWaiter = {
      serverId,
      fingerprint,
      invalidatedReason: undefined,
      wake: () => wakeWaiter?.(),
    };
    this.waiters.add(waiter);
    try {
      while (true) {
        if (waiter.invalidatedReason !== undefined) {
          return { status: "invalidated", reason: waiter.invalidatedReason };
        }
        if (signal?.aborted) return { status: "aborted" };
        const activeForServer = this.countActiveForServer(serverId);
        const forServer = activeForServer + this.countRetiringForServer(serverId);
        const activeTotal = this.countActiveTotal();
        const total = activeTotal + this.retiring.size;
        if (forServer < this.options.maxSessionsPerServer && total < this.options.maxSessions) {
          const reservation: RoomReservation = {
            serverId,
            fingerprint,
            invalidatedReason: undefined,
          };
          this.reservations.add(reservation);
          return { status: "reserved", reservation };
        }
        const idle = (onlyThisServer: boolean) =>
          [...this.sessions.values()]
            .filter(
              (session) => !session.busy && (!onlyThisServer || session.serverId === serverId),
            )
            .toSorted((a, b) => a.lastUsed - b.lastUsed);
        // Only evict a healthy idle session when active (non-retiring) counts alone hit a cap.
        if (forServer >= this.options.maxSessionsPerServer) {
          if (activeForServer >= this.options.maxSessionsPerServer) {
            const candidate = idle(true)[0];
            if (candidate === undefined) return { status: "busy" };
            candidate.close("too many sessions were open for this server");
            continue;
          }
        } else if (total >= this.options.maxSessions) {
          if (activeTotal >= this.options.maxSessions) {
            const candidate = idle(false)[0];
            if (candidate === undefined) return { status: "busy" };
            candidate.close("too many MCP server processes were open");
            continue;
          }
        }
        const relevantRetiring =
          forServer >= this.options.maxSessionsPerServer
            ? [...this.retiring].filter((session) => session.serverId === serverId)
            : [...this.retiring];
        if (relevantRetiring.length === 0) return { status: "busy" };
        const waited = await this.waitForAnyExit(relevantRetiring, deadline, signal, (wake) => {
          wakeWaiter = wake;
        });
        wakeWaiter = undefined;
        if (waiter.invalidatedReason !== undefined) {
          return { status: "invalidated", reason: waiter.invalidatedReason };
        }
        if (waited === "aborted" || waited === "timeout") return { status: waited };
      }
    } finally {
      wakeWaiter = undefined;
      this.waiters.delete(waiter);
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
