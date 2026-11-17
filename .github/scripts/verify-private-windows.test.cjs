const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  peSignature,
  windowsVerifier,
  validateUpdateConfiguration,
} = require("./verify-private-windows.cjs");
function pe() {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt32LE(400, 232);
  bytes.writeUInt32LE(16, 236);
  bytes.writeUInt32LE(16, 400);
  bytes.writeUInt16LE(0x200, 404);
  bytes.writeUInt16LE(2, 406);
  bytes.write("testcert", 408);
  return bytes;
}
test("PE inventory finds extension-independent embedded Authenticode", () => {
  assert.equal(peSignature(pe()).toString(), "testcert");
  assert.equal(peSignature(Buffer.from("plain text")), null);
});
test("unsigned, truncated, or invalid certificate entries fail closed", () => {
  for (const edit of [
    (b) => b.writeUInt32LE(0, 236),
    (b) => b.writeUInt32LE(900, 232),
    (b) => b.writeUInt16LE(1, 406),
    (b) => b.writeUInt32LE(900, 400),
  ]) {
    const bytes = pe();
    edit(bytes);
    assert.throws(() => peSignature(bytes));
  }
});
test("Windows trust is authoritative and checks all payload hashes, publisher, and timestamp", () => {
  const script = windowsVerifier();
  for (const required of [
    "Get-AuthenticodeSignature",
    "[switch]$RunRuntimeChecks",
    "if ($RunRuntimeChecks)",
    "verify-windows-desktop-artifact.mjs",
    "smoke-cli-archive.mjs",
    "[string]$ExpectedPublisher",
    "[string]$ExpectedSourceSha",
    "$report.sourceSha -cne $ExpectedSourceSha",
    "$signature.Status -ne 'Valid'",
    "$signature.SignerCertificate.Subject -cne $ExpectedPublisher",
    "!$signature.TimeStamperCertificate",
    "Get-FileHash",
    "Compare-Object",
    "Execution inventory does not match actual payload",
    "sourceSha",
    "SmartScreen reputation is not guaranteed",
  ])
    assert.ok(script.includes(required), required);
  assert.doesNotMatch(
    script,
    /Start-Process|Set-AuthenticodeSignature|Import-Certificate|TrustedPublisher|Invoke-WebRequest/,
  );
});

test("updater configuration pins actual product repository and publisher", () => {
  const publisher = "CN=Latitudes Technology Consulting";
  const valid = {
    provider: "github",
    owner: "shuv1337",
    repo: "s2code",
    publisherName: [publisher],
  };
  assert.equal(validateUpdateConfiguration(valid, publisher).repo, "s2code");
  for (const bad of [
    { repo: "windows-ci" },
    { owner: "attacker" },
    { publisherName: ["other"] },
    { url: "https://example.com" },
  ])
    assert.throws(() => validateUpdateConfiguration({ ...valid, ...bad }, publisher));
});
