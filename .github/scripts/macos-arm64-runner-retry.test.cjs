const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MAC_ARM64_CALLERS,
  NOT_ACQUIRED_ANNOTATION,
  SUCCESS_AFTER_MISS_NOTICE,
  buildJobName,
  classifyAttempts,
  splitDesktopMatrix,
} = require("./macos-arm64-runner-retry.cjs");

const workflow = fs.readFileSync(path.join(__dirname, "../workflows/release.yml"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "../workflows/release-desktop.yml"), "utf8");

test("splits macOS arm64 out of the shared desktop matrix", () => {
  const split = splitDesktopMatrix({
    include: [
      { platform: "mac", arch: "arm64", runner: "macos-26", label: "macOS arm64" },
      { platform: "mac", arch: "x64", runner: "macos-15-intel", label: "macOS x64" },
      { platform: "linux", arch: "x64", runner: "ubuntu-24.04", label: "Linux x64" },
    ],
  });
  assert.equal(split.mac.runner, "macos-26");
  assert.deepEqual(
    split.rest.include.map((target) => target.label),
    ["macOS x64", "Linux x64"],
  );
  assert.throws(() => splitDesktopMatrix({ include: [] }), /one macOS arm64/);
});

test("retries only a hosted runner that was never assigned", () => {
  const missed = {
    name: buildJobName(MAC_ARM64_CALLERS[0]),
    conclusion: "cancelled",
    runner_id: 0,
    steps: [],
  };
  assert.equal(classifyAttempts([missed]).reason, "not-acquired");
  assert.equal(classifyAttempts([missed]).ok, false);
  assert.equal(
    classifyAttempts([
      missed,
      {
        name: buildJobName(MAC_ARM64_CALLERS[1]),
        conclusion: "success",
        runner_id: 42,
        steps: [{ name: "Checkout" }],
      },
    ]).ok,
    true,
  );
  assert.equal(
    classifyAttempts([
      {
        name: buildJobName(MAC_ARM64_CALLERS[0]),
        conclusion: "failure",
        runner_id: 7,
        steps: [{ name: "Build desktop artifact", conclusion: "failure" }],
      },
    ]).reason,
    "failure",
  );
  assert.equal(
    classifyAttempts([
      { ...missed, runner_id: 7, steps: [{ name: "Checkout", conclusion: "cancelled" }] },
    ]).attempts[0].retry,
    false,
  );
  assert.equal(classifyAttempts([{ ...missed, conclusion: "failure" }]).attempts[0].retry, false);
  assert.equal(classifyAttempts([{ ...missed, runner_id: null }]).attempts[0].retry, false);
  assert.equal(classifyAttempts([{ ...missed, steps: undefined }]).attempts[0].retry, false);
  assert.equal(
    classifyAttempts([{ ...missed, annotations: [{ message: "other" }] }]).attempts[0].retry,
    false,
  );
  assert.equal(
    classifyAttempts([
      {
        ...missed,
        annotations: [
          { message: `The job was ${NOT_ACQUIRED_ANNOTATION} even after multiple attempts` },
        ],
      },
    ]).attempts[0].retry,
    true,
  );
});

test("the release workflow asks for six macos-26 acquisitions and leaves the build timeout at 30", () => {
  assert.match(desktop, /timeout-minutes: \$\{\{ inputs\.platform == 'win' && 70 \|\| 30 \}\}/);
  assert.match(workflow, /fromJSON\(needs\.preflight\.outputs\.matrix_rest\)/);
  assert.match(workflow, /runner_id 0/);
  assert.match(workflow, /needs\.mac_arm64_ready\.result == 'success'/);
  assert.equal(/continue-on-error: true\n {4}uses:/.test(workflow), false);
  assert.ok(workflow.includes("with: *mac_arm64_build"));
  assert.ok(workflow.includes("steps: *mac_arm64_check_steps"));
  for (const caller of MAC_ARM64_CALLERS) assert.ok(workflow.includes(`name: ${caller}\n`));
});

test("gate command fails closed when every attempt missed the runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-arm64-retry-"));
  const jobs = path.join(root, "jobs.jsonl");
  fs.writeFileSync(
    jobs,
    `${JSON.stringify({
      name: buildJobName(MAC_ARM64_CALLERS[0]),
      conclusion: "cancelled",
      runner_id: 0,
      steps: [],
    })}\n`,
  );
  const output = path.join(root, "github-output");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "macos-arm64-runner-retry.cjs"), "gate", jobs],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /timeout-minutes does not extend that wait/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("gate notice tells operators not to re-run after a later attempt succeeds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-arm64-retry-"));
  const jobs = path.join(root, "jobs.jsonl");
  fs.writeFileSync(
    jobs,
    [
      {
        name: buildJobName(MAC_ARM64_CALLERS[0]),
        conclusion: "cancelled",
        runner_id: 0,
        steps: [],
      },
      {
        name: buildJobName(MAC_ARM64_CALLERS[1]),
        conclusion: "success",
        runner_id: 42,
        steps: [{ name: "Checkout" }],
      },
    ]
      .map((job) => JSON.stringify(job))
      .join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "macos-arm64-runner-retry.cjs"), "gate", jobs],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`::notice::${SUCCESS_AFTER_MISS_NOTICE}`));
  fs.rmSync(root, { recursive: true, force: true });
});
