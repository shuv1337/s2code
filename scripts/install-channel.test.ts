// @effect-diagnostics nodeBuiltinImport:off - Real installer fixtures use disposable homes and local archives.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import { expect, it } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
const platform = HostProcess.Platform.defaultValue();
const arch = HostProcess.Architecture.defaultValue();

it.skipIf(platform === "win32" || (platform === "darwin" && arch !== "arm64"))(
  "installs channel caches and commands side by side without altering existing stable data",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "channel-installer-"));
    const server = NodeHttp.createServer((request, response) => {
      try {
        response.end(NodeFS.readFileSync(NodePath.join(root, "mirror", request.url ?? "")));
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener");
    try {
      const home = NodePath.join(root, "home");
      const shared = NodePath.join(home, ".shuv2code-v2", "userdata");
      NodeFS.mkdirSync(shared, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(shared, "statev2.sqlite"), "original-state");
      for (const channel of ["stable", "nightly", "preview"]) {
        const version = `1.2.3${channel === "stable" ? "" : `-${channel}.20261014.1`}`;
        const stem = `t3-${version}-${platform}-${arch}`;
        const source = NodePath.join(root, stem);
        const release = NodePath.join(root, "mirror", `v${version}`);
        NodeFS.mkdirSync(source);
        NodeFS.mkdirSync(release, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(source, "t3"), `#!/bin/sh\necho '${version}'\n`, {
          mode: 0o755,
        });
        const archive = NodePath.join(release, `${stem}.tar.gz`);
        NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", root, stem]);
        const hash = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(archive))
          .digest("hex");
        NodeFS.writeFileSync(NodePath.join(release, "SHA256SUMS"), `${hash}  ${stem}.tar.gz\n`);
        const env = {
          ...process.env,
          HOME: home,
          T3CODE_HOME: "",
          T3CODE_CHANNEL: channel,
          T3CODE_VERSION: version,
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        };
        const child = NodeChildProcess.spawn(
          "sh",
          [NodePath.join(import.meta.dirname, "install.sh")],
          { env },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += String(data);
        });
        child.stderr.on("data", (data) => {
          output += String(data);
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("close", resolve);
          child.on("error", reject);
        });
        expect(code, output).toBe(0);
        const suffix = channel === "stable" ? "" : `-${channel}`;
        expect(
          NodeFS.readFileSync(
            NodePath.join(
              home,
              `.shuv2code-v2${suffix}`,
              "runtime",
              "versions",
              version,
              ".install-complete",
            ),
            "utf8",
          ).trim(),
        ).toBe(version);
        expect(
          NodeChildProcess.execFileSync(
            NodePath.join(root, "bin", `shuv2code${suffix}`),
            ["--version"],
            { encoding: "utf8" },
          ).trim(),
        ).toBe(version);
      }
      expect(NodeFS.readFileSync(NodePath.join(shared, "statev2.sqlite"), "utf8")).toBe(
        "original-state",
      );
      expect(NodeFS.readdirSync(NodePath.join(root, "bin")).sort()).toEqual([
        "shuv2code",
        "shuv2code-nightly",
        "shuv2code-preview",
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
