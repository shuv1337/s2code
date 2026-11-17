const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");

function validateRecipient(recipient) {
  // Accept only a single native X25519 public recipient, never an identity,
  // plugin, SSH recipient, recipient file, or shell/command-line fragment.
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient ?? "")) {
    throw new Error("Expected one native age public recipient (age1...).");
  }
  return recipient;
}

async function sha256(file) {
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function oneFile(directory, extension) {
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(extension));
  if (names.length !== 1) throw new Error(`Expected exactly one ${extension} file.`);
  const file = path.join(directory, names[0]);
  if (!fs.lstatSync(file).isFile()) throw new Error("Delivery inputs must be regular files.");
  return file;
}

async function prepareDelivery({
  root,
  installerDir,
  cliDir,
  runtimeDir,
  report,
  windowsVerifier,
  runtimeVerifiers,
  sha,
  version,
  runId,
}) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Invalid source SHA.");
  if (!/^\d+\.\d+\.\d+-nightly\.ci\.\d+$/.test(version ?? "")) {
    throw new Error("Expected a generated nightly build version.");
  }
  if (!/^\d+$/.test(runId ?? "")) throw new Error("Invalid workflow run ID.");
  if (!fs.lstatSync(report).isFile()) throw new Error("A verification report is required.");
  // The build verifier owns signature/publisher checks. Preserve its evidence,
  // rather than claiming Windows trust from a Linux build or a SHA alone.
  const verification = JSON.parse(fs.readFileSync(report, "utf8"));
  if (verification.sourceSha !== sha || verification.version !== version) {
    throw new Error("Verification report does not describe this source/version.");
  }
  if (!fs.lstatSync(windowsVerifier).isFile()) throw new Error("A Windows verifier is required.");
  const installer = oneFile(installerDir, ".exe");
  const cli = oneFile(cliDir, ".zip");
  const runtime = oneFile(runtimeDir, ".tar.gz");
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  const files = [];
  for (const source of [installer, cli]) {
    const name = path.basename(source);
    fs.copyFileSync(source, path.join(root, name), fs.constants.COPYFILE_EXCL);
    files.push({ name, sha256: await sha256(source), bytes: fs.statSync(source).size });
  }
  fs.copyFileSync(report, path.join(root, "verification.json"), fs.constants.COPYFILE_EXCL);
  files.push({
    name: "verification.json",
    sha256: await sha256(report),
    bytes: fs.statSync(report).size,
  });
  fs.copyFileSync(
    windowsVerifier,
    path.join(root, "verify-windows.ps1"),
    fs.constants.COPYFILE_EXCL,
  );
  files.push({
    name: "verify-windows.ps1",
    sha256: await sha256(windowsVerifier),
    bytes: fs.statSync(windowsVerifier).size,
  });
  const expectedRuntimeVerifiers = ["verify-windows-desktop-artifact.mjs", "smoke-cli-archive.mjs"];
  if (
    !Array.isArray(runtimeVerifiers) ||
    runtimeVerifiers.length !== 2 ||
    runtimeVerifiers.some(
      (file, index) =>
        path.basename(file) !== expectedRuntimeVerifiers[index] || !fs.lstatSync(file).isFile(),
    )
  )
    throw new Error("Both bundled runtime verifiers are required.");
  for (const source of runtimeVerifiers) {
    const name = path.basename(source);
    fs.copyFileSync(source, path.join(root, name), fs.constants.COPYFILE_EXCL);
    files.push({ name, sha256: await sha256(source), bytes: fs.statSync(source).size });
  }
  const provenance = {
    sourceRepository: "shuv1337/s2code",
    sourceSha: sha,
    version,
    workflowRun: `https://github.com/shuv1337/s2code/actions/runs/${runId}`,
    updateRepository: "shuv1337/s2code",
    publicReleasePublished: false,
    windowsTrustVerified: false,
    windowsTrustVerificationRequiredBeforeInstall: true,
    wslRuntime: { name: path.basename(runtime), sha256: await sha256(runtime) },
    files: [...files],
  };
  fs.writeFileSync(path.join(root, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", {
    flag: "wx",
  });
  files.push({ name: "provenance.json", sha256: await sha256(path.join(root, "provenance.json")) });
  fs.writeFileSync(
    path.join(root, "SHA256SUMS"),
    files.map((file) => `${file.sha256}  ${file.name}\n`).join(""),
    { flag: "wx" },
  );
  return provenance;
}

async function encryptDelivery({ root, output, recipient, age = "age", tar = "tar" }) {
  validateRecipient(recipient);
  if (!output.endsWith(".age")) throw new Error("Ciphertext output must end in .age.");
  if (fs.existsSync(output) || fs.existsSync(`${output}.partial`))
    throw new Error("Output already exists.");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const childExit = (child) =>
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error("Delivery encryption subprocess failed.")),
      );
    });
  const archive = spawn(tar, ["-czf", "-", "-C", root, "."], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const cipher = spawn(
    age,
    ["--encrypt", "--recipient", recipient, "--output", `${output}.partial`],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  try {
    await Promise.all([
      childExit(archive),
      childExit(cipher),
      pipeline(archive.stdout, cipher.stdin),
    ]);
    const fd = fs.openSync(`${output}.partial`, "r");
    const header = Buffer.alloc("age-encryption.org/v1\n".length);
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString() !== "age-encryption.org/v1\n")
      throw new Error("Output is not native age ciphertext.");
    fs.renameSync(`${output}.partial`, output);
  } catch (error) {
    // These are only the two processes spawned above, never a name/path match.
    archive.kill();
    cipher.kill();
    fs.rmSync(`${output}.partial`, { force: true });
    throw error;
  }
}

module.exports = { validateRecipient, sha256, oneFile, prepareDelivery, encryptDelivery };

if (require.main === module) {
  const recipient = validateRecipient(process.env.AGE_RECIPIENT);
  const root = path.join(process.env.RUNNER_TEMP, "encrypted-windows-plaintext");
  const output = path.join(
    process.env.RUNNER_TEMP,
    "encrypted-windows-output",
    "s2code-windows.tar.gz.age",
  );
  prepareDelivery({
    root,
    installerDir: "release-private/windows-desktop",
    cliDir: "release-private/windows-cli",
    runtimeDir: "release-private/linux-runtime",
    report: "release-private/verification.json",
    windowsVerifier: "release-private/verify-windows.ps1",
    runtimeVerifiers: [
      "release-private/verify-windows-desktop-artifact.mjs",
      "release-private/smoke-cli-archive.mjs",
    ],
    sha: process.env.GITHUB_SHA,
    version: process.env.PRIVATE_BUILD_VERSION,
    runId: process.env.GITHUB_RUN_ID,
  })
    .then(() => encryptDelivery({ root, output, recipient }))
    .then(() => {
      fs.rmSync(root, { recursive: true, force: true });
      process.stdout.write(
        "Encrypted Windows delivery prepared. No plaintext artifacts uploaded.\n",
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
