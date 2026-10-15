// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Execute checked-in guard/signature steps with offline fixtures, never GitHub or signing services.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
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
          published_at: new Date().toISOString(),
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
      repo: { owner: "shuv1337", repo: "shuv2code" },
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
    await execute(require, github, context, core);
    expect(outputs).toEqual({ allowed_ref: "true", due: "false" });
    expect(notices.join(" ")).toContain("No release needed");
    await execute(require, github, { ...context, ref: "refs/heads/feature" }, core);
    expect(outputs).toEqual({ allowed_ref: "false", due: "false" });
    const publish = workflow.split("  publish:\n")[1]!;
    expect(publish).toContain("needs.due.outputs.allowed_ref == 'true'");
    expect(publish).toContain("github.event.repository.default_branch");
    expect(publish).toContain("startsWith(github.ref, 'refs/tags/v')");
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
    expect(desktop).not.toContain("SHUV2CODE_CLERK_");
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
        .split(
          "      - name: Verify Windows installer signatures before declaring a signed receipt\n",
        )[1]!
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
