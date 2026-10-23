// @effect-diagnostics nodeBuiltinImport:off -- unit names and RAM size come from the host.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AgentScope,
  agentScopeCommand,
  type AgentScopeShape,
  type AgentSystemdScope,
} from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { LEGACY_PRODUCT_ID, PRODUCT_ID } from "@t3tools/shared/productIdentity";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

/**
 * All fork environments, development servers, and release channels deliberately
 * share one agents/terminals budget per systemd user manager, even though channels
 * are independent installations. A runaway in one can kill an agent in another.
 * app-s2code-agents.slice is below app-s2code.slice, whose parent app.slice
 * also contains the server service. Keep the service's CPUWeight/IOWeight: the
 * intermediate fork slice still competes with it; renaming does not remove that.
 *
 * Existing pre-upgrade scopes stay in app-t3code-agents.slice until their sessions
 * exit, and its runtime limits last until the user manager restarts. We neither
 * move nor sweep/reset those scopes: their names cannot distinguish old fork work
 * from upstream work. Only newly launched sessions use the fork slice.
 */
const AGENT_SLICE = `app-${PRODUCT_ID}-agents.slice`;

export function ownedAgentSlice(stateDir: string, productId: string = PRODUCT_ID): string {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  return `app-${productId}-agents-${hash}.slice`;
}

/** A pre-rename server left its agents under the old product's slice name. */
export const leftoverAgentSlices = (stateDir: string) => [
  ownedAgentSlice(stateDir),
  ownedAgentSlice(stateDir, LEGACY_PRODUCT_ID),
];

const GiB = 1024 ** 3;

/**
 * Memory limits for this product's agents slice, not a host-wide reservation.
 * The cap leaves about 6 GiB outside this slice before throttling and 4 GiB before
 * a cgroup kill to give the server, sshd, and tailscaled room. Other workloads can
 * use that room: in particular, upstream has its own independent RAM-minus-4-GiB
 * cap. Two 12-GiB slices on a 16-GiB host do not preserve 4 GiB globally. We cannot
 * safely change upstream's budget, and merely detecting its slice does not prove
 * how much it will consume later. Operators must limit concurrent work across
 * products or set an aggregate host policy; agent oom_score_adj is only a fallback
 * preference for the global OOM killer, not a memory reservation.
 * Small machines still give agents
 * at least half of RAM before throttling and three quarters before a kill.
 */
export function agentSliceMemoryLimits(totalBytes: number) {
  return {
    high: Math.max(totalBytes - 6 * GiB, Math.floor(totalBytes / 2)),
    max: Math.max(totalBytes - 4 * GiB, Math.floor(totalBytes * 0.75)),
  };
}

export interface ScopeState {
  readonly loadState: string;
  readonly activeState: string;
  readonly result: string;
  readonly oomKills: number;
  readonly populated: boolean | undefined;
}

/**
 * Our pipe can close before systemd handles the kill, so a scope that is
 * still stopping, is empty, or already counted an OOM kill is "stopping":
 * systemd records `Result=oom-kill` for it in a moment.
 */
export function classifyScope(state: ScopeState): "oom-killed" | "gone" | "running" | "stopping" {
  if (state.result === "oom-kill") return "oom-killed";
  if (
    state.loadState !== "loaded" ||
    state.activeState === "inactive" ||
    state.activeState === "failed"
  ) {
    return "gone";
  }
  if (state.activeState === "deactivating" || state.oomKills > 0 || state.populated === false) {
    return "stopping";
  }
  return "running";
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

function parseCgroupCounter(text: string, key: string): number | undefined {
  const match = new RegExp(`^${key} (\\d+)$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

// A stop sends SIGTERM, then SIGKILL after this long. systemd's 90 s default
// would outlast the wait for a previous server's agents below.
const STOP_TIMEOUT_OPTION = "--property=TimeoutStopSec=10s";
const STOPPING_POLL_INTERVAL = "100 millis";
const STOPPING_POLL_ATTEMPTS = 20;
const CLEAR_FAILED_INTERVAL = "1 second";
const CLEAR_FAILED_ATTEMPTS = 120;
const MAX_TRACKED_THREADS = 500;

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return AgentScope.defaultValue();

  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnvironment = yield* HostProcess.Environment;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const ownedSlice = ownedAgentSlice(stateDir);
  const layerScope = yield* Effect.scope;

  const resolve = (command: string, env: NodeJS.ProcessEnv) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
    );

  const run = (command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeout: "5 seconds" }).pipe(Effect.option);

  const readCgroupFile = (controlGroup: string, file: string) =>
    fileSystem
      .readFileString(path.join("/sys/fs/cgroup", controlGroup, file))
      .pipe(Effect.orElseSucceed(() => ""));

  // Old agents keep their scopes when the server is killed, and the restarted
  // server resumes their sessions. Stop them first, so two copies of one
  // session never work in the same worktree.
  const stopLeftoverAgents = (systemctl: string) =>
    Effect.gen(function* () {
      for (const slice of leftoverAgentSlices(stateDir)) {
        const shown = yield* run(systemctl, [
          "--user",
          "show",
          slice,
          "--property=ActiveState,ControlGroup",
        ]);
        if (shown._tag === "None") continue;
        const values = parseKeyValues(shown.value.stdout);
        if (values.get("ActiveState") !== "active") continue;
        const controlGroup = values.get("ControlGroup") ?? "";
        const events = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
        if (parseCgroupCounter(events, "populated") === 0) continue;
        yield* Effect.logWarning("Stopping agents left by a previous server", { slice });
        const stopped = yield* runner
          .run({ command: systemctl, args: ["--user", "stop", slice], timeout: "30 seconds" })
          .pipe(Effect.option);
        if (stopped._tag === "None" || stopped.value.code !== 0) {
          yield* Effect.logWarning("Could not stop agents left by a previous server", {
            slice,
            stderr: stopped._tag === "Some" ? stopped.value.stderr.trim() : undefined,
          });
        }
      }
    });

  const systemd = yield* Effect.cached(
    Effect.gen(function* () {
      const runtimeDir = hostEnvironment.XDG_RUNTIME_DIR;
      if (runtimeDir === undefined || runtimeDir.length === 0) return undefined;
      const systemdRun = yield* resolve("systemd-run", hostEnvironment);
      const systemctl = yield* resolve("systemctl", hostEnvironment);
      if (systemdRun === null || systemctl === null) return undefined;
      yield* stopLeftoverAgents(systemctl);
      const probe = (options: ReadonlyArray<string>) =>
        run(systemdRun, [
          "--user",
          "--scope",
          "--quiet",
          "--collect",
          `--slice=${AGENT_SLICE}`,
          ...options,
          "--",
          "true",
        ]).pipe(Effect.map((result) => result._tag === "Some" && result.value.code === 0));
      // Stop the whole scope when the kernel kills one of its processes, and
      // record the result as oom-kill. Scopes take OOMPolicy from systemd 253;
      // older user managers still get scopes, without the OOM label.
      const stopOptions = [STOP_TIMEOUT_OPTION];
      const oomOptions = [...stopOptions, "--property=OOMPolicy=stop"];
      const scopeOptions = (yield* probe(oomOptions))
        ? oomOptions
        : (yield* probe(stopOptions))
          ? stopOptions
          : undefined;
      if (scopeOptions === undefined) {
        yield* Effect.logInfo("Agent scopes are off: no systemd user manager");
        return undefined;
      }
      const limits = agentSliceMemoryLimits(NodeOS.totalmem());
      const limited = yield* run(systemctl, [
        "--user",
        "set-property",
        "--runtime",
        AGENT_SLICE,
        `MemoryHigh=${limits.high}`,
        `MemoryMax=${limits.max}`,
      ]);
      if (limited._tag === "None" || limited.value.code !== 0) {
        yield* Effect.logWarning("Could not set memory limits on the agents slice", {
          stderr: limited._tag === "Some" ? limited.value.stderr.trim() : undefined,
        });
      }
      yield* Effect.logInfo("Agent scopes are on", {
        slice: AGENT_SLICE,
        ...limits,
        oomPolicy: scopeOptions.length > 0,
      });
      return {
        systemdRun,
        systemctl,
        runtimeDir,
        scopeOptions,
      };
    }),
  );

  const scopeByThread = new Map<string, { unit: string; oomKilled: boolean }>();

  const readScope = (systemctl: string, unit: string) =>
    Effect.gen(function* () {
      const shown = yield* run(systemctl, [
        "--user",
        "show",
        unit,
        "--property=LoadState,ActiveState,Result,ControlGroup",
      ]);
      if (shown._tag === "None" || shown.value.code !== 0) return undefined;
      const values = parseKeyValues(shown.value.stdout);
      const controlGroup = values.get("ControlGroup") ?? "";
      const memoryEvents = controlGroup ? yield* readCgroupFile(controlGroup, "memory.events") : "";
      const cgroupEvents = controlGroup ? yield* readCgroupFile(controlGroup, "cgroup.events") : "";
      const populated = parseCgroupCounter(cgroupEvents, "populated");
      return {
        loadState: values.get("LoadState") ?? "",
        activeState: values.get("ActiveState") ?? "",
        result: values.get("Result") ?? "",
        oomKills: parseCgroupCounter(memoryEvents, "oom_kill") ?? 0,
        populated: populated === undefined ? undefined : populated === 1,
      } satisfies ScopeState;
    });

  const clearFailed = (systemctl: string, unit: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < CLEAR_FAILED_ATTEMPTS; attempt++) {
        const state = yield* readScope(systemctl, unit);
        if (state === undefined) return;
        if (state.activeState === "failed") {
          yield* run(systemctl, ["--user", "reset-failed", unit]);
          return;
        }
        if (state.activeState !== "deactivating") return;
        yield* Effect.sleep(CLEAR_FAILED_INTERVAL);
      }
    });

  const forget = (systemctl: string, unit: string) =>
    clearFailed(systemctl, unit).pipe(Effect.forkIn(layerScope), Effect.asVoid);

  const evictOldest = (systemctl: string) =>
    Effect.gen(function* () {
      const oldest = scopeByThread.entries().next();
      if (oldest.done === true) return;
      const [threadId, tracked] = oldest.value;
      const state = yield* readScope(systemctl, tracked.unit);
      if (scopeByThread.get(threadId) !== tracked) return;
      scopeByThread.delete(threadId);
      const status = state === undefined ? "running" : classifyScope(state);
      if (status === "running" || status === "stopping") {
        scopeByThread.set(threadId, tracked);
        return;
      }
      yield* forget(systemctl, tracked.unit);
    });

  const track = (systemctl: string, threadId: string, unit: string | undefined) =>
    Effect.gen(function* () {
      const previous = scopeByThread.get(threadId);
      scopeByThread.delete(threadId);
      if (unit !== undefined) scopeByThread.set(threadId, { unit, oomKilled: false });
      if (previous !== undefined) yield* forget(systemctl, previous.unit);
      if (scopeByThread.size > MAX_TRACKED_THREADS) yield* evictOldest(systemctl);
    });

  const oomKilled: AgentScopeShape["oomKilled"] = (threadId) =>
    Effect.gen(function* () {
      const tracked = scopeByThread.get(threadId);
      if (tracked === undefined) return false;
      if (tracked.oomKilled) return true;
      const scope = yield* systemd;
      if (scope === undefined) return false;
      for (let attempt = 0; attempt < STOPPING_POLL_ATTEMPTS; attempt++) {
        const state = yield* readScope(scope.systemctl, tracked.unit);
        if (state === undefined) return false;
        const status = classifyScope(state);
        if (status === "running") return false;
        if (status === "stopping") {
          yield* Effect.sleep(STOPPING_POLL_INTERVAL);
          continue;
        }
        yield* forget(scope.systemctl, tracked.unit);
        if (status === "gone") return false;
        yield* Effect.logWarning("Agent scope was killed: out of memory", {
          threadId,
          unit: tracked.unit,
        });
        tracked.oomKilled = true;
        return true;
      }
      return false;
    });

  const clear: AgentScopeShape["clear"] = (threadId) =>
    Effect.gen(function* () {
      if (!scopeByThread.has(threadId)) return;
      const scope = yield* systemd;
      if (scope !== undefined) yield* track(scope.systemctl, threadId, undefined);
    });

  return {
    wrap: Effect.fn("AgentScope.wrap")(function* ({
      command,
      args,
      name,
      threadId,
      env,
      survivesRestart,
    }) {
      const resolved = yield* resolve(command, env ?? hostEnvironment);
      if (resolved === null) return { command, args };
      const scope = yield* systemd;
      if (scope === undefined) return agentScopeCommand({ command: resolved, args });
      const unit = `${PRODUCT_ID}-${name}-${NodeCrypto.randomUUID().slice(0, 8)}.scope`;
      if (threadId !== undefined) yield* track(scope.systemctl, threadId, unit);
      const systemdScope: AgentSystemdScope = {
        systemdRun: scope.systemdRun,
        runtimeDir: scope.runtimeDir,
        slice: survivesRestart === true ? AGENT_SLICE : ownedSlice,
        unit,
        // Without a thread nothing reads the result, so let systemd unload
        // the unit even when it fails.
        options: threadId === undefined ? [...scope.scopeOptions, "--collect"] : scope.scopeOptions,
      };
      return agentScopeCommand({ command: resolved, args, scope: systemdScope });
    }),
    oomKilled,
    clear,
  } satisfies AgentScopeShape;
});

export const layer = Layer.effect(AgentScope, make).pipe(Layer.provide(ProcessRunner.layer));
