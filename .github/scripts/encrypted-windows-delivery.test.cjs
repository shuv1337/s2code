const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  validateRecipient,
  prepareDelivery,
  encryptDelivery,
  oneFile,
} = require("./encrypted-windows-delivery.cjs");
const recipient = "age1pnnx5x69znwzcntnqmqhxf70ujpgawa6mat7p5pqnt3xj3l68ygq9e66fr";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "encrypted-delivery-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    root: path.join(dir, "plaintext"),
    sha: "a".repeat(40),
    version: "0.1.7-nightly.ci.123",
    runId: "123",
  };
  for (const [key, filename] of [
    ["installerDir", "S2Code Setup.exe"],
    ["cliDir", "cli.zip"],
    ["runtimeDir", "linux.tar.gz"],
  ]) {
    options[key] = path.join(dir, key);
    fs.mkdirSync(options[key]);
    fs.writeFileSync(path.join(options[key], filename), filename);
  }
  options.report = path.join(dir, "report.json");
  options.windowsVerifier = path.join(dir, "verify.ps1");
  fs.writeFileSync(
    options.report,
    JSON.stringify({ sourceSha: options.sha, version: options.version }),
  );
  fs.writeFileSync(options.windowsVerifier, "# verify offline Windows trust");
  options.runtimeVerifiers = ["verify-windows-desktop-artifact.mjs", "smoke-cli-archive.mjs"].map(
    (name) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "// fixture verifier");
      return file;
    },
  );
  return { dir, options };
}
test("only one native public recipient is accepted", () => {
  assert.equal(validateRecipient(recipient), recipient);
  for (const value of [
    "",
    "AGE-SECRET-KEY-1abc",
    "ssh-ed25519 abc",
    `${recipient}\n`,
    `${recipient} --identity secret`,
    "age1" + "b".repeat(58),
  ])
    assert.throws(() => validateRecipient(value));
});
test("delivery binds source/version and hashes the private installer, CLI and verifier", async (t) => {
  const { options } = fixture(t);
  const provenance = await prepareDelivery(options);
  assert.equal(provenance.publicReleasePublished, false);
  assert.equal(provenance.windowsTrustVerified, false);
  assert.equal(provenance.windowsTrustVerificationRequiredBeforeInstall, true);
  assert.equal(provenance.updateRepository, "shuv1337/s2code");
  assert.deepEqual(
    fs.readdirSync(options.root).sort(),
    [
      "S2Code Setup.exe",
      "SHA256SUMS",
      "cli.zip",
      "provenance.json",
      "verification.json",
      "verify-windows.ps1",
      "verify-windows-desktop-artifact.mjs",
      "smoke-cli-archive.mjs",
    ].sort(),
  );
  assert.match(
    fs.readFileSync(path.join(options.root, "SHA256SUMS"), "utf8"),
    /[a-f0-9]{64}  verify-windows.ps1/,
  );
  assert.equal(provenance.files.length, 6);
});
test("mismatched evidence and versions fail closed", async (t) => {
  const { options } = fixture(t);
  await assert.rejects(prepareDelivery({ ...options, sha: "b".repeat(40) }), /does not describe/);
  await assert.rejects(
    prepareDelivery({ ...options, version: "0.1.7-nightly.20261117" }),
    /nightly build/,
  );
  assert.equal(fs.existsSync(options.root), false);
});
test("ambiguous files and symlinks cannot enter delivery", (t) => {
  const { options } = fixture(t);
  fs.writeFileSync(path.join(options.cliDir, "extra.zip"), "bad");
  assert.throws(() => oneFile(options.cliDir, ".zip"), /exactly one/);
  fs.unlinkSync(path.join(options.installerDir, "S2Code Setup.exe"));
  fs.symlinkSync(options.report, path.join(options.installerDir, "S2Code Setup.exe"));
  assert.throws(() => oneFile(options.installerDir, ".exe"), /regular files/);
});
test("failed encryption never produces an uploadable artifact", async (t) => {
  const { dir, options } = fixture(t);
  await prepareDelivery(options);
  const output = path.join(dir, "out", "delivery.age");
  await assert.rejects(
    encryptDelivery({ root: options.root, output, recipient, age: "/usr/bin/false" }),
  );
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.partial`), false);
  await assert.rejects(
    encryptDelivery({ root: options.root, output: output + ".zip", recipient }),
    /end in .age/,
  );
});
test("workflow uses protected exact-main source, isolated OIDC and only ciphertext uploads", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../workflows/encrypted-windows-build.yml"),
    "utf8",
  );
  for (const guard of [
    "github.repository == 'shuv1337/s2code'",
    "github.event_name == 'workflow_dispatch'",
    "github.ref == 'refs/heads/main'",
    "environment: fork-release",
    "ref: ${{ github.sha }}",
    "persist-credentials: false",
    'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
  ])
    assert.ok(workflow.includes(guard), guard);
  assert.equal((workflow.match(/uses: actions\/upload-artifact@/g) || []).length, 1);
  assert.match(
    workflow,
    /path: \$\{\{ runner.temp \}\}\/encrypted-windows-output\/s2code-windows.tar.gz.age/,
  );
  assert.match(workflow, /retention-days: 7/);
  assert.doesNotMatch(
    workflow,
    /actions\/cache|actions\/download-artifact|gh release|AZURE_SIGNING_RELEASE_ENABLED|secrets\.|workflow_call|pull_request/,
  );
  assert.equal((workflow.match(/uses: azure\/login@/g) || []).length, 2);
  assert.equal((workflow.match(/az account get-access-token/g) || []).length, 2);
  assert.match(workflow, /T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true"/);
  assert.match(workflow, /--signed --skip-build/);
  assert.match(workflow, /S2CODE_DESKTOP_UPDATE_REPOSITORY: shuv1337\/s2code/);
  assert.match(workflow, /--frozen-lockfile/);
});
