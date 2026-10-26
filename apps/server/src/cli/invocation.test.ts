import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import { formatServiceStatus } from "./service.ts";
import { formatBootServiceProblem } from "../cloud/bootService.ts";

// Root-command tests exercise PATH handling with a stable install; channel
// selection is covered separately with explicit versions below.
vi.mock("../../package.json", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("../../package.json") }>();
  return { default: { ...actual.default, version: "1.2.3" } };
});

import {
  formatCliCommand,
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
  resolveCliCommand,
  resolveUninstallGuidance,
} from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs", "npx @s2code/cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\t3\\dist\\bin.mjs",
      "npx @s2code/cli serve",
    ],
    ["/home/theo/.cache/pnpm/dlx/abc/node_modules/t3/dist/bin.mjs", "pnpm dlx @s2code/cli serve"],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/t3/dist/bin.mjs",
      "pnpm dlx @s2code/cli serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\t3\\dist\\bin.mjs",
      "pnpm dlx @s2code/cli serve",
    ],
    ["/home/theo/.bun/install/cache/t3@0.0.31/dist/bin.mjs", "bunx @s2code/cli serve"],
    ["/tmp/bunx-1000-t3@latest/node_modules/t3/dist/bin.mjs", "bunx @s2code/cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-t3@latest\\node_modules\\t3\\dist\\bin.mjs",
      "bunx @s2code/cli serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/t3/dist/bin.mjs",
    "/home/theo/Code/work/t3code/apps/server/dist/bin.mjs",
    "/home/theo/.t3/runtime/0.0.31/node_modules/t3/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "s2code serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx @s2code/cli@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx @s2code/cli@0.0.31-preview.20260729.1 serve"],
    ["0.0.31-pr.42.1", "npx @s2code/cli@0.0.31-pr.42.1 serve"],
    ["0.0.31-foo-preview.20260729.1", "npx @s2code/cli serve"],
    ["0.0.31", "npx @s2code/cli serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx @s2code/cli@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-t3@latest/node_modules/t3/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx @s2code/cli serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/t3/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "s2code-nightly serve",
  );
});

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  const pathWithT3 = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "s2code"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs";
      // sudo's secure_path already has a system Node.
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo npx @s2code/cli browser setup",
      );
      // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" npx @s2code/cli browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/t3/dist/bin.mjs",
          path: yield* pathWithT3,
        }),
      ).toBe(
        'sudo env "PATH=$PATH" /home/theo/.local/node/bin/node /home/theo/.local/lib/node_modules/t3/dist/bin.mjs browser setup',
      );
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher when t3 is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "s2code");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(
        shim,
        "#!/bin/sh\n# Written by s2code: runs the desktop app's bundled CLI.\n",
        { mode: 0o755 },
      );
      const desktop = {
        node: "/tmp/.mount_T3abc/t3code",
        entry: "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { T3CODE_CLI_PATH: shim },
      };
      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);

      expect(yield* rootCommand({ ...desktop, path: yield* pathWithT3 })).toBe(
        `sudo '${shim}' browser setup`,
      );

      expect(
        yield* rootCommand({
          node: "/opt/t3/t3",
          entry: "/opt/t3/t3",
          executable: true,
        }),
      ).toBe("sudo /opt/t3/t3 browser setup");

      expect(
        yield* rootCommand({ ...desktop, env: { T3CODE_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" s2code browser setup');
      const upstreamShim = path.join(home, "t3");
      yield* fs.writeFileString(upstreamShim, "#!/bin/sh\n# Written by T3 Code: bundled CLI\n", {
        mode: 0o755,
      });
      expect(yield* rootCommand({ ...desktop, env: { T3CODE_CLI_PATH: upstreamShim } })).toBe(
        'sudo env "PATH=$PATH" s2code browser setup',
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "s2code.cmd");
      yield* fs.writeFileString(
        shim,
        "@echo off\r\nREM Written by s2code: runs the desktop app's bundled CLI.\r\n",
      );
      const hostCommand = (
        platform: NodeJS.Platform,
        env: Record<string, string>,
        baseDir = "C:\\Users\\Jane Doe\\.t3",
      ) =>
        resolveHostCliCommand("doctor", ["--base-dir", baseDir]).pipe(
          Effect.provideService(
            HostProcess.ExecutablePath,
            "C:\\Program Files\\S2Code\\s2code.exe",
          ),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\S2Code\\s2code.exe",
            "C:\\Program Files\\S2Code\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      // The desktop shim is called through `&`, and each argument is quoted
      // the PowerShell way: no POSIX single quotes anywhere.
      expect((yield* hostCommand("win32", { T3CODE_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.t3"`,
      );
      expect((yield* hostCommand("win32", {})).command).toBe(
        's2code doctor "--base-dir" "C:\\Users\\Jane Doe\\.t3"',
      );
      // Typographic quotes also delimit PowerShell strings; doubling keeps them.
      expect((yield* hostCommand("win32", {}, "C:\\T3\\\u201CArchive\u201D")).command).toBe(
        's2code doctor "--base-dir" "C:\\T3\\\u201C\u201CArchive\u201D\u201D"',
      );
      // POSIX hosts keep single quotes for the same input.
      expect((yield* hostCommand("linux", { T3CODE_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.t3'$/,
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("source-install host commands", (it) => {
  it.effect("calls a source runtime and entry through PowerShell on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const entry = path.join(checkout, "my src", "bin.mjs");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.writeFileString(entry, "");
      const hostCommand = (platform: NodeJS.Platform) =>
        resolveHostCliCommand("doctor").pipe(
          Effect.provideService(HostProcess.ExecutablePath, "C:\\Program Files\\nodejs\\node.exe"),
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.WorkingDirectory, checkout),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
        );
      expect(yield* hostCommand("win32")).toEqual({
        command: `& "C:\\Program Files\\nodejs\\node.exe" "${entry}" doctor`,
        launcher: false,
      });
      expect((yield* hostCommand("linux")).command).toBe(
        `'C:\\Program Files\\nodejs\\node.exe' '${entry}' doctor`,
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for both script and executable packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/t3/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@t3code/t3-linux-x64/t3", "npx"],
        ["pnpm/dlx/hash/node_modules/t3/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/t3/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, entry),
          Effect.provideService(HostProcess.IsExecutable, entry.endsWith("/t3")),
        );
        expect(installation).toEqual({ kind });
        const guidance = yield* resolveUninstallGuidance.pipe(
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, entry),
          Effect.provideService(HostProcess.IsExecutable, entry.endsWith("/t3")),
        );
        expect(guidance).toContain("temporary fork package-runner");
        expect(guidance).not.toContain("npm uninstall");
        if (entry.endsWith("/t3")) {
          expect(
            yield* resolveCliCommand("service install").pipe(
              Effect.provideService(HostProcess.Arguments, [entry, "serve"]),
              Effect.provideService(HostProcess.ExecutablePath, entry),
              Effect.provideService(HostProcess.IsExecutable, true),
            ),
          ).toBe("npx @s2code/cli service install");
        }
      }
    }),
  );

  it.effect.each([
    ["@s2code/cli", "s2code"],
    ["shuv2code", "shuv2code"],
  ] as const)(
    "requires the %s npm prefix bin to point to the running package",
    ([packageName, binName]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const prefix = path.join(root, "bunx-tools");
        const packageRoot = path.join(prefix, "lib/node_modules", packageName);
        const entry = path.join(packageRoot, "dist/bin.mjs");
        const globalBin = path.join(prefix, "bin", binName);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
        yield* fs.writeFileString(entry, "");
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: packageName,
            version: "0.0.45",
            bin: { [binName]: "./dist/bin.mjs" },
          }),
        );
        const resolve = resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(yield* resolve).toBeNull();
        yield* fs.symlink(entry, globalBin);
        expect(yield* resolve).toEqual({
          kind: "npm-global",
          prefix: yield* fs.realPath(prefix),
          packageName,
        });
        const guidance = yield* resolveUninstallGuidance.pipe(
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(guidance).toContain(
          `npm uninstall --global --prefix ${yield* fs.realPath(prefix)} ${packageName}`,
        );
        expect(guidance).not.toMatch(/npm uninstall[^`]*\bt3\b/);
        const command = yield* resolveCliCommand("service install").pipe(
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(command).toBe(`${yield* fs.realPath(prefix)}/bin/${binName} service install`);
        expect(
          formatServiceStatus(
            {
              supported: true,
              installed: false,
              current: false,
              unitPath: "fork.service",
              logPath: "fork.log",
            },
            "1.2.3",
            () => command,
          ),
        ).toContain(command);
        yield* fs.remove(globalBin);
        yield* fs.writeFileString(globalBin, "an unrelated t3 command");
        expect(yield* resolve).toBeNull();
        expect(
          yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32")),
        ).toBeNull();
      }),
  );

  it.effect("proves the native executable belongs to the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/@s2code/cli");
      const launcher = path.join(packageRoot, "bin/t3.js");
      const entry = path.join(packageRoot, "node_modules/@s2code/t3-linux-x64/t3");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"@s2code/cli","version":"0.0.45","bin":{"s2code":"./bin/t3.js"},"optionalDependencies":{"@s2code/t3-linux-x64":"0.0.45"}}',
      );
      yield* fs.symlink(launcher, path.join(prefix, "bin/s2code"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, entry),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      for (const [version, expected] of [
        ["0.0.44", null],
        [
          "0.0.45",
          { kind: "npm-global", prefix: yield* fs.realPath(prefix), packageName: "@s2code/cli" },
        ],
      ]) {
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "package.json"),
          `{"name":"@s2code/t3-linux-x64","version":"${version}"}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/t3/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".t3/runtime/0.0.45/t3",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});

it.layer(NodeServices.layer)("fork recovery instructions", (it) => {
  it.effect(
    "uses the installed standalone channel binary and never offers npm removal for it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const exe = path.join(root, "s2code-nightly");
        yield* fs.writeFileString(exe, "binary fixture");
        yield* Effect.gen(function* () {
          expect(yield* resolveRootCliCommand("browser setup")).toBe(`sudo ${exe} browser setup`);
          expect(yield* resolveCliCommand("service install")).toBe(`${exe} service install`);
          expect(yield* resolveUninstallGuidance).toContain("standalone fork binary");
          expect(yield* resolveUninstallGuidance).not.toContain("npm uninstall");
        }).pipe(
          Effect.provideService(HostProcess.ExecutablePath, exe),
          Effect.provideService(HostProcess.Arguments, [exe]),
          Effect.provideService(HostProcess.IsExecutable, true),
          Effect.provideService(HostProcess.Environment, {}),
        );
      }),
  );
  it.effect(
    "keeps source commands on their exact runtime and checkout without global removal advice",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const entry = path.join(root, "bunx-tools source", "apps/server/dist/bin.mjs");
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "source fixture");
        const resolvedEntry = yield* fs.realPath(entry);
        yield* Effect.gen(function* () {
          const command = yield* resolveRootCliCommand("browser setup");
          expect(command).toBe(`sudo /usr/bin/node '${resolvedEntry}' browser setup`);
          expect(yield* resolveUninstallGuidance).toContain("source");
          expect(yield* resolveUninstallGuidance).not.toContain("npm uninstall");
          const install = yield* resolveCliCommand("service install");
          expect(install).toBe(`/usr/bin/node '${resolvedEntry}' service install`);
          expect(yield* resolveCliCommand("service install", "/work/fork home")).toBe(
            `/usr/bin/node '${resolvedEntry}' service install --base-dir '/work/fork home'`,
          );
          expect(
            formatBootServiceProblem("service-stopped", {
              version: "1.2.3-nightly.20261014.1",
              command: () => install,
            }),
          ).toContain("systemctl --user status s2code-v2-nightly.service");
        }).pipe(
          Effect.provideService(HostProcess.Arguments, [
            "node",
            "bunx-tools source/apps/server/dist/bin.mjs",
          ]),
          Effect.provideService(HostProcess.WorkingDirectory, root),
        );
      }).pipe(
        Effect.provideService(HostProcess.ExecutablePath, "/usr/bin/node"),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Environment, {}),
      ),
  );
});
