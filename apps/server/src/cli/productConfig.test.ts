// @effect-diagnostics nodeBuiltinImport:off - Real startup resolution uses disposable homes, not a running server.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { resolveProductEnvironment } from "@t3tools/shared/productIdentity";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import { resolveServerConfig, type CliServerFlags } from "./config.ts";
import { vi } from "vite-plus/test";
vi.mock("../../package.json", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("../../package.json") }>();
  return { default: { ...actual.default, version: "1.2.3" } };
});

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-cli-config-"));
});
afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const flags: CliServerFlags = {
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
};
function resolve(env: Record<string, string>, overrides: Partial<CliServerFlags> = {}) {
  // This is the same adapter used before the CLI's internal Config values load.
  const resolved = resolveProductEnvironment(env);
  const compact = Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return resolveServerConfig({ ...flags, ...overrides }, Option.none()).pipe(
    Effect.provide([
      NodeServices.layer,
      NetService.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: compact })),
    ]),
    Effect.provideService(HostProcess.HomeDirectory, root),
  );
}
it.effect("ignores inherited upstream home and port before deriving state paths", () =>
  Effect.gen(function* () {
    const upstream = NodePath.join(root, ".t3");
    NodeFS.mkdirSync(upstream);
    NodeFS.writeFileSync(NodePath.join(upstream, "sentinel"), "unchanged");
    const config = yield* resolve({ T3CODE_HOME: upstream, T3CODE_PORT: "4444" });
    expect(config.baseDir).toBe(NodePath.join(root, ".shuv2code-v2"));
    expect(config.port).not.toBe(4444);
    expect(NodeFS.readdirSync(upstream)).toEqual(["sentinel"]);
  }),
);
it.effect("honors explicit fork settings and keeps CLI flags above them", () =>
  Effect.gen(function* () {
    const config = yield* resolve({
      SHUV2CODE_HOME: NodePath.join(root, "custom"),
      SHUV2CODE_PORT: "4773",
    });
    expect(config.baseDir).toBe(NodePath.join(root, "custom"));
    expect(config.port).toBe(4773);
    const overridden = yield* resolve(
      { SHUV2CODE_HOME: NodePath.join(root, "custom"), SHUV2CODE_PORT: "4773" },
      {
        baseDir: Option.some(NodePath.join(root, "explicit")),
        port: Option.some(5773),
      },
    );
    expect(overridden.baseDir).toBe(NodePath.join(root, "explicit"));
    expect(overridden.port).toBe(5773);
  }),
);
it.effect("does not open inherited upstream state even with a launcher context", () =>
  Effect.gen(function* () {
    const home = NodePath.join(root, "service-home");
    NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(home, ".product-identity"), "shuv2code\n");
    NodeFS.writeFileSync(NodePath.join(home, "userdata", "statev2.sqlite"), "original-db");
    const config = yield* resolve({
      T3CODE_HOME: home,
      T3_SERVICE_LAUNCHER_CONTEXT: JSON.stringify({ version: "1.2.3" }),
    });
    expect(config.baseDir).toBe(NodePath.join(root, ".shuv2code-v2"));
    expect(config.dbPath).not.toBe(NodePath.join(home, "userdata", "statev2.sqlite"));
    expect(NodeFS.readFileSync(NodePath.join(home, "userdata", "statev2.sqlite"), "utf8")).toBe(
      "original-db",
    );
  }),
);
it.effect("refuses an explicit upstream home before opening or creating state", () =>
  Effect.gen(function* () {
    const upstream = NodePath.join(root, ".t3");
    NodeFS.mkdirSync(upstream);
    const failure = yield* resolve({ SHUV2CODE_HOME: upstream }).pipe(Effect.flip);
    expect(String(failure)).toContain("upstream .t3 home");
    expect(NodeFS.readdirSync(upstream)).toEqual([]);
  }),
);
