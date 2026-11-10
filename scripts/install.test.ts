// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const fixtureEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        USERPROFILE: root,
      };
      const version = "1.2.3";
      const stem = `s2code-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync(
        "tar",
        ["-czf", NodePath.join(root, archiveName), "-C", root, stem],
        { env: fixtureEnv },
      );
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (!request.url?.endsWith(`/${archiveName}`)) {
          response.writeHead(404).end();
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...fixtureEnv,
          TERM: "xterm",
          NO_COLOR: "1",
          S2CODE_VERSION: version,
          S2CODE_HOME: NodePath.join(root, "home"),
          S2CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          S2CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed s2code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed s2code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-product"), "utf8"),
          ).toBe("s2code\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/s2code"), ["--version"], {
              encoding: "utf8",
              env: fixtureEnv,
            }).trim(),
          ).toBe("t3 v1.2.3");
          expect(await NodeFSP.readdir(versions)).toEqual([version]);
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer home", () => {
  it("installs a relative home from a directory ending in a newline", async () => {
    const temporaryRoot = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-home-")),
    );
    const root = NodePath.join(temporaryRoot, "cwd\n");
    // Product settings are trimmed, so only the cwd keeps its trailing newline.
    const homeName = "-custom home\\home";
    const home = NodePath.join(root, homeName);
    const version = "1.2.3";
    const target = NodePath.join(home, "runtime/versions", version);
    const launcher = NodePath.join(root, "bin/s2code");
    try {
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(home, ".product-identity"), "s2code\n");
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await NodeFSP.writeFile(NodePath.join(target, ".install-product"), "s2code\n");
      await NodeFSP.writeFile(NodePath.join(target, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const { status, stdout, stderr } = NodeChildProcess.spawnSync(
        "sh",
        [NodePath.resolve(import.meta.dirname, "install.sh")],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            S2CODE_HOME: homeName,
            S2CODE_VERSION: version,
            S2CODE_INSTALL_BIN_DIR: NodePath.dirname(launcher),
            S2CODE_RELEASE_BASE_URL: "http://127.0.0.1:1",
          },
          encoding: "utf8",
        },
      );
      expect(status, stdout + stderr).toBe(0);
      expect(stderr).toContain(`Installed s2code ${version}`);
      expect(await NodeFSP.realpath(launcher)).toBe(NodePath.join(target, "t3"));
      expect(
        NodeChildProcess.execFileSync(launcher, ["--version"], {
          cwd: NodeOS.tmpdir(),
          encoding: "utf8",
        }).trim(),
      ).toBe("t3 v1.2.3");
    } finally {
      await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    ["stable", "1.2.3"],
    ["preview", "1.2.4-preview.20261019.50"],
  ])("finds the newest %s release behind a full page of nightlies", async (channel, version) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "s2code-install-index-"));
    const target = NodePath.join(root, "home/runtime/versions", version);
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const body =
        url.pathname === "/shuv1337/s2code/releases/latest" &&
        request.headers.accept === "application/json"
          ? { tag_name: "v1.2.3" }
          : url.pathname === "/repos/shuv1337/s2code/releases"
            ? { "1": nightlies, "2": [{ tag_name: `v${version}` }, { tag_name: "v1.2.3" }] }[
                url.searchParams.get("page") ?? ""
              ]
            : undefined;
      if (body === undefined) response.statusCode = 404;
      // The API pretty-prints and the installer reads it line by line.
      response.end(JSON.stringify(body ?? [], null, 2));
    });
    try {
      // An existing completed install isolates release resolution from archive downloads.
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, "home/.product-identity"), "s2code\n");
      await NodeFSP.writeFile(NodePath.join(target, "t3"), "#!/bin/sh\n", { mode: 0o755 });
      await NodeFSP.writeFile(NodePath.join(target, ".install-product"), "s2code\n");
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const source = await NodeFSP.readFile(
        NodePath.resolve(import.meta.dirname, "install.sh"),
        "utf8",
      );
      const installer = NodePath.join(root, "install.sh");
      await NodeFSP.writeFile(installer, source.replace(/https:\/\/(api\.)?github\.com/g, origin));
      const { code, output } = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = NodeChildProcess.spawn("sh", [installer], {
            env: {
              ...process.env,
              HOME: root,
              S2CODE_VERSION: "",
              SHUV2CODE_VERSION: "",
              S2CODE_CHANNEL: channel,
              SHUV2CODE_CHANNEL: "",
              S2CODE_HOME: NodePath.join(root, "home"),
              SHUV2CODE_HOME: "",
              S2CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              SHUV2CODE_INSTALL_BIN_DIR: "",
              // A wrong version must fail here instead of downloading a real release.
              S2CODE_RELEASE_BASE_URL: origin,
              SHUV2CODE_RELEASE_BASE_URL: "",
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        },
      );
      expect(code, output).toBe(0);
      expect(output).toContain(`Installed s2code ${version}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

/** Runs an installer for a version that is already unpacked, so only the s2code command step runs. */
async function installOver(input: {
  readonly script: "install.sh" | "install.ps1";
  readonly root: string;
  readonly home: string;
  readonly binDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}) {
  const target = NodePath.join(input.home, "runtime", "versions", "1.2.3");
  await NodeFSP.mkdir(target, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(input.home, ".product-identity"), "s2code\n");
  await NodeFSP.writeFile(NodePath.join(target, ".install-product"), "s2code\n");
  await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), "1.2.3\n");
  await NodeFSP.writeFile(
    NodePath.join(target, input.script === "install.sh" ? "t3" : "t3.exe"),
    "#!/bin/sh\n",
    { mode: 0o755 },
  );
  const installer = NodePath.resolve(import.meta.dirname, input.script);
  const [command, args] =
    input.script === "install.sh"
      ? ["sh", [installer]]
      : ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]];
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: {
      ...process.env,
      HOME: input.root,
      USERPROFILE: input.root,
      SHUV2CODE_CHANNEL: "",
      S2CODE_CHANNEL: "",
      S2CODE_VERSION: "1.2.3",
      S2CODE_HOME: input.home,
      S2CODE_INSTALL_BIN_DIR: input.binDir,
      S2CODE_RELEASE_BASE_URL: "http://127.0.0.1:9",
      ...input.env,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, target };
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "install.sh s2code command",
  () => {
    it("replaces only this home's own links and prints a PATH command", async () => {
      const root = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "s2code-install-link-")),
      );
      try {
        const home = NodePath.join(root, "home");
        const binDir = NodePath.join(root, "bin");
        const link = NodePath.join(binDir, "s2code");
        await NodeFSP.mkdir(binDir, { recursive: true });

        const unsafe = await installOver({
          root,
          script: "install.sh",
          home,
          binDir,
          env: { VITEST: "true", HOME: "" },
        });
        expect(unsafe.code).not.toBe(0);
        expect(unsafe.output).toContain("Tests must set HOME to an explicit temporary directory");
        expect(await NodeFSP.readdir(binDir)).toEqual([]);

        await NodeFSP.writeFile(link, "#!/bin/sh\necho mine\n");
        const foreign = await installOver({ root, script: "install.sh", home, binDir });
        expect(foreign.code).not.toBe(0);
        expect(foreign.output).toContain(`Refusing to replace an existing command: ${link}`);
        expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");
        // Not even from inside the versions folder, where `.` would resolve into it.
        const fromVersions = await installOver({
          root,
          script: "install.sh",
          home,
          binDir,
          cwd: foreign.target,
        });
        expect(fromVersions.code).not.toBe(0);
        expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");

        // A link that only looks like it points into versions (join() would normalize the ..).
        await NodeFSP.rm(link);
        await NodeFSP.mkdir(NodePath.join(home, "other"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(home, "other/t3"), "#!/bin/sh\n");
        await NodeFSP.symlink(`${home}/runtime/versions/../../other/t3`, link);
        const climbing = await installOver({ root, script: "install.sh", home, binDir });
        expect(climbing.code).not.toBe(0);
        expect(await NodeFSP.readlink(link)).toBe(`${home}/runtime/versions/../../other/t3`);

        // Only `<version>/t3` counts, not another program inside a version.
        await NodeFSP.rm(link);
        await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/helper"), link);
        const sibling = await installOver({ root, script: "install.sh", home, binDir });
        expect(sibling.code).not.toBe(0);
        expect(await NodeFSP.readlink(link)).toBe(
          NodePath.join(home, "runtime/versions/1.0.0/helper"),
        );

        // An upgrade over an older version's link, written through a symlinked T3 home.
        await NodeFSP.rm(link);
        await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/t3"), link);
        await NodeFSP.symlink(home, NodePath.join(root, "alias"));
        const upgrade = await installOver({
          root,
          script: "install.sh",
          home: NodePath.join(root, "alias"),
          binDir,
          env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
        });
        expect(upgrade.code, upgrade.output).toBe(0);
        expect(await NodeFSP.readlink(link)).toBe(NodePath.join(binDir, "shuv2code"));
        expect(await NodeFSP.realpath(link)).toBe(NodePath.join(home, "runtime/versions/1.2.3/t3"));
        expect(upgrade.output).toContain(`Add ${binDir} to your PATH`);

        // Containers and CI often have no SHELL; `set -u` must not stop the installer there.
        const noShell = await installOver({
          root,
          script: "install.sh",
          home,
          binDir,
          env: { HOME: root, SHELL: undefined, PATH: "/usr/bin:/bin" },
        });
        expect(noShell.code, noShell.output).toBe(0);
        expect(noShell.output).toContain(`Add ${binDir} to your PATH`);

        // The fork prints a PATH hint for a trailing slash rather than a shell-specific edit.
        const slashed = await installOver({
          root,
          script: "install.sh",
          home,
          binDir,
          env: { HOME: root, PATH: `${binDir}/:/usr/bin:/bin` },
        });
        expect(slashed.code, slashed.output).toBe(0);
        expect(slashed.output).toContain(`Add ${binDir} to your PATH`);

        // A relative folder is made absolute, so the PATH command never follows the working directory.
        const relative = await installOver({
          root,
          script: "install.sh",
          home,
          binDir: "bin",
          cwd: root,
          env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
        });
        expect(relative.code, relative.output).toBe(0);
        expect(relative.output).toContain(`Add ${binDir} to your PATH`);

        await NodeFSP.rm(link);
        await NodeFSP.symlink(NodePath.join(home, "bin/t3"), link);
        const overDesktop = await installOver({
          root,
          script: "install.sh",
          home: `${home}//`,
          binDir: `${binDir}/`,
        });
        expect(overDesktop.code).not.toBe(0);
        expect(await NodeFSP.readlink(link)).toBe(NodePath.join(home, "bin/t3"));
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "install.ps1 s2code command",
  () => {
    it("replaces only its own s2code.cmd, also in non-ASCII and bracketed paths", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-ps1-"));
      try {
        // Windows PowerShell 5.1 reads files as ANSI by default and expands wildcards in paths.
        const home = NodePath.join(root, "José", ".s2code-v2");
        const binDir = NodePath.join(root, "bin[t3]");
        const shim = NodePath.join(binDir, "s2code.cmd");
        await NodeFSP.mkdir(binDir, { recursive: true });

        const desktopShim = '@echo off\r\n"C:\\Program Files\\S2Code\\S2Code.exe" "x" %*\r\n';
        await NodeFSP.writeFile(shim, desktopShim);
        const foreign = await installOver({ root, script: "install.ps1", home, binDir });
        expect(foreign.code).not.toBe(0);
        expect(foreign.output).toContain(
          "Refusing to replace a command owned by another installation:",
        );
        expect(await NodeFSP.readFile(shim, "utf8")).toBe(desktopShim);

        // A hand-edited wrapper may set its own environment; replacing it would drop that.
        const edited = `@echo off\r\nset "S2CODE_HOME=D:\\other"\r\n"${NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe")}" %*`;
        await NodeFSP.writeFile(shim, edited, "utf8");
        const wrapper = await installOver({ root, script: "install.ps1", home, binDir });
        expect(wrapper.code).not.toBe(0);
        expect(await NodeFSP.readFile(shim, "utf8")).toBe(edited);

        const climbing = `@echo off\r\n"${NodePath.join(home, "runtime", "versions")}\\..\\other\\t3.exe" %*`;
        await NodeFSP.writeFile(shim, climbing, "utf8");
        const outside = await installOver({ root, script: "install.ps1", home, binDir });
        expect(outside.code).not.toBe(0);
        expect(await NodeFSP.readFile(shim, "utf8")).toBe(climbing);

        const older = NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe");
        await NodeFSP.writeFile(shim, `@echo off\r\n"${older}" %*`, "utf8");
        const upgrade = await installOver({ root, script: "install.ps1", home, binDir });
        expect(upgrade.code, upgrade.output).toBe(0);
        expect(await NodeFSP.readFile(shim, "utf8")).toContain("shuv2code.cmd");
        expect(await NodeFSP.readFile(NodePath.join(binDir, "shuv2code.cmd"), "utf8")).toContain(
          NodePath.join(upgrade.target, "t3.exe"),
        );

        const again = await installOver({ root, script: "install.ps1", home, binDir });
        expect(again.code, again.output).toBe(0);

        // The fork leaves PATH edits to the user even when another command is first.
        const otherBin = NodePath.join(root, "other");
        await NodeFSP.mkdir(otherBin);
        await NodeFSP.writeFile(NodePath.join(otherBin, "s2code.cmd"), "@echo off\r\n");
        // Windows spells it Path; a second PATH key would be ambiguous.
        const pathKey =
          Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
        const shadowed = await installOver({
          root,
          script: "install.ps1",
          home,
          binDir,
          env: { [pathKey]: `${otherBin};${process.env[pathKey] ?? ""}` },
        });
        expect(shadowed.code, shadowed.output).toBe(0);
        expect(shadowed.output).toContain(`Add ${binDir} to your PATH`);

        // A trailing separator still prints the fork's generic PATH hint.
        const slashed = await installOver({
          root,
          script: "install.ps1",
          home,
          binDir,
          env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
        });
        expect(slashed.code, slashed.output).toBe(0);
        expect(slashed.output).toContain(`Add ${binDir} to your PATH`);
        // The same when the install folder itself is given with a trailing separator.
        const bothSlashed = await installOver({
          root,
          script: "install.ps1",
          home,
          binDir: `${binDir}\\`,
          env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
        });
        expect(bothSlashed.code, bothSlashed.output).toBe(0);
        expect(bothSlashed.output).toContain(`Add ${binDir} to your PATH`);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.each(
    ["home\\data", "home\ndata"].flatMap((homeName) =>
      [true, false].map((validChecksum) => ({ homeName, validChecksum })),
    ),
  )(
    "verifies home $homeName with valid checksum $validChecksum",
    async ({ homeName, validChecksum }) => {
      const availableTools = ["sha256sum", "shasum"].filter(
        (tool) =>
          NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool]).status === 0,
      );
      expect(availableTools.length).toBeGreaterThan(0);
      for (const checksumTool of availableTools) {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-checksum-"));
        const home = NodePath.join(root, homeName);
        const version = "1.2.3";
        const stem = `s2code-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
        const archiveName = `${stem}.tar.gz`;
        const server = NodeHttp.createServer();
        try {
          const tools = NodePath.join(root, "tools");
          await NodeFSP.mkdir(tools);
          for (const command of [
            "sh",
            "uname",
            "tar",
            "gzip",
            "cut",
            "curl",
            "grep",
            "mkdir",
            "mktemp",
            "rm",
            "mv",
            "ln",
            "sed",
            "tr",
            "head",
            "dirname",
            "basename",
            checksumTool,
          ]) {
            const executable = NodeChildProcess.execFileSync(
              "sh",
              ["-c", 'command -v "$1"', "sh", command],
              { encoding: "utf8" },
            ).trim();
            await NodeFSP.symlink(executable, NodePath.join(tools, command));
          }
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3"),
            "#!/bin/sh\necho 't3 v1.2.3'\n",
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(root, archiveName);
          NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
          const archive = await NodeFSP.readFile(archivePath);
          const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          server.on("request", (request, response) => {
            response.end(
              request.url?.endsWith("/SHA256SUMS")
                ? `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}\n`
                : archive,
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "sh",
                [NodePath.resolve(import.meta.dirname, "install.sh")],
                {
                  env: {
                    ...process.env,
                    HOME: root,
                    PATH: tools,
                    S2CODE_VERSION: version,
                    S2CODE_HOME: home,
                    S2CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    S2CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          const versions = NodePath.join(home, "runtime/versions");
          if (validChecksum) {
            expect(code, `${checksumTool}: ${output}`).toBe(0);
            expect(
              await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
            ).toBe("1.2.3\n");
            expect(
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/s2code"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3 v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed s2code");
            expect(await NodeFSP.readdir(versions)).toEqual([]);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});
