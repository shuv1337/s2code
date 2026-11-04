// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Execute checked-in guard/signature steps with offline fixtures, never GitHub or signing services.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import { desktopAssetGroups } from "./lib/fork-release.ts";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const desktop = NodeFS.readFileSync(
  new URL("../.github/workflows/release-desktop.yml", import.meta.url),
  "utf8",
);
const due = workflow.split("  due:\n")[1]!.split("\n  preflight:")[0]!;

describe("fork workflow gates", () => {
  it("checks a not-due nightly without entering a protected environment", async () => {
    expect(due).not.toContain("environment:");
    expect(due).toContain("contents: read");
    expect(workflow.split("  preflight:\n")[1]!.split("\n  build_bundle:")[0]).toContain(
      "if: needs.due.outputs.due == 'true'",
    );
    const script = due.split("          script: |\n")[1]!.replace(/^            /gm, "");
    const execute = new Function(
      "require",
      "github",
      "context",
      "core",
      `return (async()=>{${script}})();`,
    );
    const outputs: Record<string, string> = {};
    const notices: string[] = [];
    const github = {
      paginate: async () => [
        {
          draft: false,
          tag_name: "v1.2.3-nightly.20261014.1",
          published_at: "2026-10-14T06:00:00.000Z",
        },
      ],
      rest: {
        repos: {
          listReleases: () => {},
          compareCommitsWithBasehead: async () => ({ data: { status: "identical" } }),
        },
      },
    };
    const context = {
      eventName: "schedule",
      ref: "refs/heads/main",
      sha: "ab".repeat(20),
      repo: { owner: "shuv1337", repo: "s2code" },
      payload: { repository: { default_branch: "main" } },
    };
    const core = {
      setOutput: (key: string, value: string) => {
        outputs[key] = value;
      },
      notice: (value: string) => notices.push(value),
      info: () => {},
    };
    const require = NodeModule.createRequire(new URL("../package.json", import.meta.url));
    // The latest nightly went out an hour ago, inside the release interval.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse("2026-10-14T07:00:00.000Z"));
      await execute(require, github, context, core);
      expect(outputs).toEqual({ allowed_ref: "true", due: "false" });
      expect(notices.join(" ")).toContain("No release needed");
      await execute(require, github, { ...context, ref: "refs/heads/feature" }, core);
      expect(outputs).toEqual({ allowed_ref: "false", due: "false" });
    } finally {
      vi.useRealTimers();
    }
    const publish = workflow.split("  publish:\n")[1]!;
    expect(publish).toContain("needs.due.outputs.allowed_ref == 'true'");
    expect(publish).toContain("github.event.repository.default_branch");
    expect(publish).not.toContain("refs/tags/");
    expect(workflow).not.toContain("\n  prepare:\n");
    expect(publish).toContain("needs: [due, preflight, desktop, desktop_win_x64, mac_arm64_ready]");
    for (const gate of ["desktop", "mac_arm64_ready"])
      expect(publish).toContain(`needs.${gate}.result == 'success'`);
    // A failed Windows build must not block publishing.
    expect(publish.split("    runs-on:")[0]).not.toContain("desktop_win_x64.result");
    // Folding prepare in must not widen what the publisher's steps can reach.
    const publishJob = publish.split("    steps:\n")[0]!;
    expect(publishJob).toContain("    environment: fork-release\n");
    expect(publishJob.split("    permissions:\n")[1]!.trimEnd().split("\n")).toEqual([
      "      contents: write",
      "      actions: read",
      "      id-token: write",
      "    env:",
      "      GITHUB_DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}",
      "      GH_TOKEN: ${{ github.token }}",
      "      S2CODE_NPM_TRUSTED_PUBLISHING_READY: ${{ vars.S2CODE_NPM_TRUSTED_PUBLISHING_READY }}",
      "      FORK_NPM_TRUSTED_PUBLISHING_READY: ${{ vars.FORK_NPM_TRUSTED_PUBLISHING_READY }}",
      '      NPM_TOKEN: ""',
      '      NODE_AUTH_TOKEN: ""',
    ]);
    expect(publish).not.toContain("fork-release.ts prepare");
    expect(publish).toContain(
      "WINDOWS_BUILT: ${{ steps.windows.outputs.built }}\n        run: node scripts/fork-release.ts publish --execute",
    );
  });
  it.each([true, false])(
    "decides from the Windows installer what ships, builds npm and announces it (installer present: %s)",
    (present) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-windows-built-"));
      try {
        const version = "1.2.3-nightly.20261014.1";
        const assets = NodePath.join(root, "prepared/release-assets");
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(assets, { recursive: true });
        NodeFS.mkdirSync(NodePath.join(root, ".github/scripts"), { recursive: true });
        NodeFS.copyFileSync(
          new URL("../.github/scripts/notify-discord-release.sh", import.meta.url),
          NodePath.join(root, ".github/scripts/notify-discord-release.sh"),
        );
        // Stand-ins for the tools these steps reach the network or the builder through.
        NodeFS.mkdirSync(bin);
        for (const [name, body] of [
          ["node", `printf '%s\\n' "$@" > "${root}/node-args"`],
          ["gh", "exit 0"],
          ["git", "echo 0000000000000000000000000000000000000000"],
          [
            "curl",
            `while [ $# -gt 0 ]; do if [ "$1" = --data ]; then printf '%s' "$2" > "${root}/discord.json"; fi; shift; done; printf 204`,
          ],
        ])
          NodeFS.writeFileSync(NodePath.join(bin, name!), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
        const installer = desktopAssetGroups(version)
          .flat()
          .find((name) => name.endsWith(".exe"))!;
        if (present) NodeFS.writeFileSync(NodePath.join(assets, installer), "installer");
        // The Windows job uploads its CLI archive before it can fail.
        const strayArchive = NodePath.join(assets, `s2code-${version}-win32-x64.zip`);
        NodeFS.writeFileSync(strayArchive, "archive");
        const publish = workflow.split("  publish:\n")[1]!;
        const output = NodePath.join(root, "github-output");
        const runStep = (name: string, env: Record<string, string>) => {
          const step = publish.split(`      - name: ${name}\n`)[1]!.split("\n      - ")[0]!;
          // GitHub's default shell for run steps.
          return NodeChildProcess.spawnSync(
            "bash",
            [
              "--noprofile",
              "--norc",
              "-eo",
              "pipefail",
              "-c",
              step.split("        run: |\n")[1]!.replace(/^ {10}/gm, ""),
            ],
            {
              cwd: root,
              encoding: "utf8",
              env: {
                ...process.env,
                PATH: `${bin}${NodePath.delimiter}${process.env.PATH}`,
                RELEASE_VERSION: version,
                GITHUB_OUTPUT: output,
                GITHUB_REPOSITORY: "shuv1337/s2code",
                ...env,
              },
            },
          );
        };
        const check = runStep("Check whether Windows x64 built", {});
        expect(check.status, check.stderr).toBe(0);
        expect(NodeFS.readFileSync(output, "utf8")).toBe(`built=${present}\n`);
        expect(NodeFS.existsSync(strayArchive)).toBe(present);

        const build = runStep(
          "Build the public npm packages once from the verified-source archives",
          {
            WINDOWS_BUILT: String(present),
          },
        );
        expect(build.status, build.stderr).toBe(0);
        expect(
          NodeFS.readFileSync(NodePath.join(root, "node-args"), "utf8").includes("--allow-missing"),
        ).toBe(!present);

        const announce = runStep("Announce the release on Discord", {
          WINDOWS_BUILT: String(present),
          DISCORD_RELEASE_WEBHOOK_URL: "https://discord.invalid/fixture",
          S2CODE_NPM_TRUSTED_PUBLISHING_READY: "true",
          FORK_NPM_TRUSTED_PUBLISHING_READY: "true",
        });
        expect(announce.status, announce.stderr).toBe(0);
        const content = (
          JSON.parse(NodeFS.readFileSync(NodePath.join(root, "discord.json"), "utf8")) as {
            content: string;
          }
        ).content.split("\n");
        expect(content.some((line) => line.startsWith("npm: "))).toBe(true);
        expect(
          content.includes(
            "windows: not built; npx @s2code/cli is unavailable on Windows for this version",
          ),
        ).toBe(!present);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("turns the run red without blocking publish when Windows did not build", () => {
    const job = workflow.split("\n  windows_missing:\n")[1]!;
    expect(job).toContain("    needs: publish\n");
    expect(job).toContain("    if: always() && needs.publish.outputs.windows_built == 'false'\n");
    expect(job).toContain("exit 1");
    expect(workflow).toContain("      windows_built: ${{ steps.windows.outputs.built }}\n");
    // Only the Windows caller opts out of failing the run.
    expect(desktop).toContain("    continue-on-error: ${{ inputs.win_optional }}\n");
    expect(workflow.match(/win_optional: true/g)).toHaveLength(1);
    expect(workflow.split("  desktop_win_x64:\n")[1]!.split("\n  desktop_mac_arm64:")[0]).toContain(
      "win_optional: true",
    );
  });
  it("leaves preview signing outside the release environment and supplies the packager's existing config names", () => {
    expect(desktop).not.toContain("environment: fork-release");
    for (const name of [
      "CLERK_PUBLISHABLE_KEY",
      "CLERK_JWT_TEMPLATE",
      "CLERK_CLI_OAUTH_CLIENT_ID",
      "CLERK_PASSKEY_RP_DOMAINS",
      "RELAY_URL",
    ])
      expect(desktop).toContain(`T3CODE_${name}:`);
    expect(desktop).not.toContain("S2CODE_CLERK_");
  });
});

const hasPwsh =
  NodeChildProcess.spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"])
    .status === 0;
it.skipIf(!hasPwsh).each([
  { subject: "CN=Fork Publisher, O=Fixture", expected: "Fork Publisher", valid: true },
  {
    subject: "CN=Fork Publisher, O=Fixture",
    expected: "CN=Fork Publisher, O=Fixture",
    valid: true,
  },
  { subject: "CN=Other Fork Publisher Labs, O=Fixture", expected: "Fork Publisher", valid: false },
])(
  "requires exact certificate subject or common-name equality ($subject -> $expected)",
  ({ subject, expected, valid }) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-publisher-cert-"));
    try {
      NodeFS.mkdirSync(NodePath.join(root, "release-publish"));
      NodeFS.writeFileSync(NodePath.join(root, "release-publish/fixture.exe"), "not an executable");
      const step = desktop
        .split("      - name: Verify Windows installer signatures\n")[1]!
        .split("\n      - name:")[0]!;
      const code = step.split("        run: |\n")[1]!.replace(/^          /gm, "");
      const script = NodePath.join(root, "verify.ps1");
      // Real certificate DN/CN parsing; Authenticode status is deliberately a fixture.
      NodeFS.writeFileSync(
        script,
        `$rsa=[System.Security.Cryptography.RSA]::Create(2048)\n$request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new($env:FIXTURE_SUBJECT,$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)\n$global:fixtureCertificate=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(1))\nfunction Get-AuthenticodeSignature { [PSCustomObject]@{Status='Valid';SignerCertificate=$global:fixtureCertificate} }\n${code}`,
      );
      const result = NodeChildProcess.spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-File", script],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, FIXTURE_SUBJECT: subject, EXPECTED_PUBLISHER: expected },
        },
      );
      expect(result.status === 0, result.stderr).toBe(valid);
      if (!valid) expect(result.stderr).toContain("publisher mismatch");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

const hasSevenZip = NodeChildProcess.spawnSync("7z", ["i"]).status === 0;
// The fixture stands in for an NSIS installer: 7-Zip reads both the same way.
it.skipIf(!hasPwsh || !hasSevenZip).each([true, false])(
  "requires the WSL runtime inside the Windows installer's app payload (present: %s)",
  (present) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-wsl-payload-"));
    try {
      const sevenZip = (cwd: string, ...args: string[]) =>
        NodeChildProcess.execFileSync("7z", args, { cwd, stdio: "ignore" });
      const app = NodePath.join(root, "app");
      NodeFS.mkdirSync(NodePath.join(app, "resources"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(app, "resources", present ? "wsl-runtime.tar.gz" : "other.tar.gz"),
        "runtime",
      );
      const outer = NodePath.join(root, "outer");
      NodeFS.mkdirSync(NodePath.join(outer, "$PLUGINSDIR"), { recursive: true });
      sevenZip(app, "a", NodePath.join(outer, "$PLUGINSDIR", "app-64.7z"), "resources");
      NodeFS.mkdirSync(NodePath.join(root, "release-publish"));
      sevenZip(
        outer,
        "a",
        "-t7z",
        NodePath.join(root, "release-publish", "S2Code-x64.exe"),
        "$PLUGINSDIR",
      );
      const step = desktop
        .split("      - name: Require the WSL runtime in the Windows installer\n")[1]!
        .split("\n      - name:")[0]!;
      const script = NodePath.join(root, "check.ps1");
      NodeFS.writeFileSync(script, step.split("        run: |\n")[1]!.replace(/^ {10}/gm, ""));
      const temp = NodePath.join(root, "temp");
      NodeFS.mkdirSync(temp);
      const result = NodeChildProcess.spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-File", script],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, RUNNER_TEMP: temp, APP_PAYLOAD: "app-64.7z" },
        },
      );
      expect(result.status === 0, result.stderr).toBe(present);
      if (!present) expect(result.stderr).toContain("has no resources/wsl-runtime.tar.gz");
      // Only the nested payload came out, and nothing from inside it.
      expect(NodeFS.readdirSync(temp)).toEqual(present ? [] : ["installer-payload"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
