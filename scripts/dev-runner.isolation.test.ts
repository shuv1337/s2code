import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveProductEnvironment } from "@t3tools/shared/productIdentity";
import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { createDevRunnerEnv, resolveDevRunnerHome } from "./dev-runner.ts";

it("ignores inherited upstream homes outside worktrees and honors only explicit fork selections", () => {
  expect(resolveDevRunnerHome(undefined, undefined, { T3CODE_HOME: "/upstream" })).toBeUndefined();
  expect(
    resolveDevRunnerHome(undefined, undefined, {
      T3CODE_HOME: "/upstream",
      S2CODE_HOME: "/fork",
    }),
  ).toBe("/fork");
  expect(resolveDevRunnerHome(undefined, "/worktree/.t3", { T3CODE_HOME: "/upstream" })).toBe(
    "/worktree/.t3",
  );
});

it.effect.each(["dev", "dev:desktop"] as const)(
  "preserves managed dev home and port through the %s startup adapter",
  (mode) =>
    Effect.gen(function* () {
      const env = yield* createDevRunnerEnv({
        mode,
        baseEnv: {
          T3CODE_HOME: "/upstream",
          S2CODE_HOME: "/stale",
          T3CODE_DEV_AUTH_TOKEN: "development-token",
        },
        serverOffset: 0,
        webOffset: 0,
        t3Home: "/disposable/worktree/.t3",
        port: 4773,
        browser: undefined,
        autoBootstrapProjectFromCwd: undefined,
        logWebSocketEvents: undefined,
        host: undefined,
        devUrl: undefined,
      }).pipe(Effect.provide(NodeServices.layer));
      const resolved = resolveProductEnvironment(env);
      expect(resolved.T3CODE_HOME).toBe("/disposable/worktree/.t3");
      expect(resolved.T3CODE_PORT).toBe("4773");
      if (mode === "dev") expect(resolved.T3CODE_DEV_AUTH_TOKEN).toBe("development-token");
    }),
);

it.effect("removes ambient public homes when the dev runner selects its default", () =>
  Effect.gen(function* () {
    const env = yield* createDevRunnerEnv({
      mode: "dev",
      baseEnv: { T3CODE_HOME: "/upstream", S2CODE_HOME: "/stale" },
      serverOffset: 0,
      webOffset: 0,
      t3Home: undefined,
      port: undefined,
      browser: undefined,
      autoBootstrapProjectFromCwd: undefined,
      logWebSocketEvents: undefined,
      host: undefined,
      devUrl: undefined,
    }).pipe(Effect.provide(NodeServices.layer));
    expect(resolveProductEnvironment(env).T3CODE_HOME).toBeUndefined();
  }),
);
