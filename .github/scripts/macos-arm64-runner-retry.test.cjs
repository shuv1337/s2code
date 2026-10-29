const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MAC_ARM64_CALLERS,
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
});

test("the release workflow asks for six macos-26 acquisitions and leaves the build timeout at 30", () => {
  assert.match(desktop, /timeout-minutes: \$\{\{ inputs\.platform == 'win' && 70 \|\| 30 \}\}/);
  assert.match(workflow, /fromJSON\(needs\.preflight\.outputs\.matrix_rest\)/);
  assert.match(workflow, /runner_id 0/);
  assert.match(workflow, /needs\.mac_arm64_ready\.result == 'success'/);
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
