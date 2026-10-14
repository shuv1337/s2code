// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import { agentSliceMemoryLimits, classifyScope, make, type ScopeState } from "./agentScope.ts";

const GiB = 1024 ** 3;

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    // The agent pipe can close before systemd handles the kill.
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });

  it("does not wait on a live agent or a scope that ended for another reason", () => {
    expect(classifyScope(running)).toBe("running");
    expect(classifyScope({ ...running, activeState: "inactive", populated: undefined })).toBe(
      "gone",
    );
    expect(classifyScope({ ...running, loadState: "not-found", activeState: "inactive" })).toBe(
      "gone",
    );
  });
});

describe("agentSliceMemoryLimits", () => {
  it("leaves 6 GB before throttling and 4 GB before a kill on large machines", () => {
    expect(agentSliceMemoryLimits(64 * GiB)).toEqual({ high: 58 * GiB, max: 60 * GiB });
  });

  it("still gives agents most of a small machine", () => {
    expect(agentSliceMemoryLimits(8 * GiB)).toEqual({ high: 4 * GiB, max: 6 * GiB });
  });
});

// Runs the real service against a fake user manager. `units` holds the
// ActiveState and Result that `systemctl show` reports for each scope.
const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, { activeState: string; result: string }>;
    readonly calls: Array<{ command: string; args: ReadonlyArray<string> }>;
    readonly awaitReset: (unit: string) => Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const units = new Map<string, { activeState: string; result: string }>();
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const resetSignals = new Map<string, Deferred.Deferred<void>>();
    const resetSignal = (unit: string) => {
      const signal = resetSignals.get(unit) ?? Deferred.makeUnsafe<void>();
      resetSignals.set(unit, signal);
      return signal;
    };
    const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ command, args }) =>
        Effect.gen(function* () {
          calls.push({ command, args });
          const [, verb, unit = ""] = args;
          if (verb === "reset-failed") {
            units.delete(unit);
            yield* Deferred.succeed(resetSignal(unit), undefined);
          }
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n`,
          );
        }),
    });
    const scope = yield* make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
    );
    return yield* body({
      scope,
      units,
      calls,
      awaitReset: (unit) => Deferred.await(resetSignal(unit)),
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const unitOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";

describe("AgentScope service", () => {
  it.effect("creates and limits the fork slice for both agents and terminals", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "claude",
          threadId: "thread",
        });
        const terminal = yield* scope.wrap({ command: "agent", args: [], name: "terminal" });
        for (const launch of [agent, terminal]) {
          expect(launch.args).toContain("--slice=app-shuv2code-agents.slice");
          expect(unitOf(launch)).toMatch(/^shuv2code-(claude|terminal)-[0-9a-f]{8}\.scope$/);
        }
        const probe = calls.find(({ args }) => args.includes("--scope"));
        expect(probe?.args).toContain("--slice=app-shuv2code-agents.slice");
        const limits = calls.filter(({ args }) => args.includes("set-property"));
        expect(limits).toHaveLength(1);
        expect(limits[0]?.args).toEqual([
          "--user",
          "set-property",
          "--runtime",
          "app-shuv2code-agents.slice",
          expect.stringMatching(/^MemoryHigh=\d+$/),
          expect.stringMatching(/^MemoryMax=\d+$/),
        ]);
        expect(calls.every(({ args }) => args.every((arg) => !arg.includes("t3code")))).toBe(true);
      }),
    ),
  );

  it.effect(
    "inspects and cleans only its exact tracked scopes, never upstream or other fork scopes",
    () =>
      withFakeSystemd(({ scope, units, calls, awaitReset }) =>
        Effect.gen(function* () {
          const foreign = new Map([
            ["app-t3code-agents.slice", { activeState: "failed", result: "oom-kill" }],
            ["t3code-claude-deadbeef.scope", { activeState: "failed", result: "oom-kill" }],
            ["t3code-terminal-deadbeef.scope", { activeState: "failed", result: "exit-code" }],
            ["shuv2code-terminal-deadbeef.scope", { activeState: "failed", result: "oom-kill" }],
          ]);
          for (const [unit, state] of foreign) units.set(unit, state);
          const own: string[] = [];
          const launch = () =>
            Effect.gen(function* () {
              const wrapped = yield* scope.wrap({
                command: "agent",
                args: [],
                name: "claude",
                threadId: "thread",
              });
              const unit = unitOf(wrapped);
              own.push(unit);
              units.set(unit, { activeState: "failed", result: "oom-kill" });
              return unit;
            });
          const first = yield* launch();
          expect(yield* scope.oomKilled("thread")).toBe(true);
          yield* awaitReset(first);
          const second = yield* launch();
          const third = yield* launch(); // Replacement schedules cleanup of the second scope.
          yield* awaitReset(second);
          yield* scope.clear("thread");
          yield* awaitReset(third);
          for (const unit of foreign.keys()) {
            yield* scope.clear(unit);
            expect(yield* scope.oomKilled(unit)).toBe(false);
          }
          expect(units).toEqual(foreign);
          const cleanup = calls.filter(({ args }) => args[1] === "reset-failed");
          expect(cleanup.map(({ args }) => args[2]).sort()).toEqual([...own].sort());
          const inspection = calls.filter(({ args }) => args[1] === "show");
          expect(inspection.length).toBeGreaterThan(0);
          expect(inspection.every(({ args }) => own.includes(args[2] ?? ""))).toBe(true);
          expect(
            calls.some(
              ({ args }) =>
                args.includes("stop") ||
                args.includes("list-units") ||
                args.some((arg) => arg.includes("*")),
            ),
          ).toBe(false);
        }),
      ),
  );
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        // The older scope was OOM-killed, but the newest one is still running.
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        // A retried failure reads the same, even after the failed unit is reset.
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        // The next session may run without a scope, for example on Cursor.
        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("live")).toBe(true);
      }),
    ),
  );
});
