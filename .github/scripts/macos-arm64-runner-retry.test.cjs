const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  HOSTED_FALLBACK_RUNNER,
  MAC_ARM64_CALLERS,
  QUEUE_FALLBACK_CALLER,
  QUEUE_TIMEOUT_SECONDS,
  NOT_ACQUIRED_ANNOTATION,
  SUCCESS_AFTER_MISS_NOTICE,
  buildJobName,
  classifyAttempts,
  classifyQueue,
  fetchJobs,
  readJobsJsonl,
  splitDesktopMatrix,
} = require("./macos-arm64-runner-retry.cjs");

const script = path.join(__dirname, "macos-arm64-runner-retry.cjs");

// A `gh` on PATH that fails its first `failures` calls, then prints `jobs` as JSONL.
function fakeGh(root, { failures, jobs }) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(root, "jobs.out"), jobs.map((job) => JSON.stringify(job)).join("\n"));
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
calls=$(cat "${root}/calls" 2>/dev/null || echo 0)
echo $((calls + 1)) > "${root}/calls"
echo "$*" > "${root}/args"
if [ "$calls" -lt ${failures} ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
cat "${root}/jobs.out"
`,
    { mode: 0o755 },
  );
  return {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "shuv1337/s2code",
      GITHUB_RUN_ID: "41740484868",
      GITHUB_RUN_ATTEMPT: "1",
    },
    calls: () => Number(fs.readFileSync(path.join(root, "calls"), "utf8")),
    args: () => fs.readFileSync(path.join(root, "args"), "utf8").trim(),
  };
}

const workflow = fs.readFileSync(path.join(__dirname, "../workflows/release.yml"), "utf8");
const desktop = fs.readFileSync(path.join(__dirname, "../workflows/release-desktop.yml"), "utf8");

test("splits macOS arm64 out of the shared desktop matrix", () => {
  const split = splitDesktopMatrix({
    include: [
      {
        platform: "mac",
        arch: "arm64",
        runner: '["self-hosted","macOS","ARM64","shuvbot-macos"]',
        label: "macOS arm64",
      },
      { platform: "linux", arch: "x64", runner: "ubuntu-24.04", label: "Linux x64" },
    ],
  });
  assert.equal(split.mac.runner, '["self-hosted","macOS","ARM64","shuvbot-macos"]');
  assert.equal(HOSTED_FALLBACK_RUNNER, "macos-26");
  assert.deepEqual(split.fallback, { ...split.mac, runner: "macos-26" });
  assert.deepEqual(
    split.rest.include.map((target) => target.label),
    ["Linux x64"],
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

test("the release workflow tries shuvbot first, falls back to hosted macos-26, and leaves the build timeout at 30", () => {
  assert.match(desktop, /timeout-minutes: \$\{\{ inputs\.platform == 'win' && 70 \|\| 30 \}\}/);
  assert.match(workflow, /fromJSON\(needs\.preflight\.outputs\.matrix_rest\)/);
  assert.match(workflow, /runner_id 0/);
  assert.match(workflow, /needs\.mac_arm64_ready\.result == 'success'/);
  assert.equal(/continue-on-error: true\n {4}uses:/.test(workflow), false);
  assert.ok(workflow.includes("with: &mac_arm64_fallback_build"));
  assert.ok(workflow.includes("with: *mac_arm64_fallback_build"));
  assert.match(workflow, /matrix_mac_arm64_fallback\)\.runner/);
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

test("the Xcode guard accepts only the pinned stable Xcode, whatever its path says", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "require-stable-xcode-"));
  const run = ({
    version,
    build,
    developerDir = `${root}/Xcode-27.1.0.app/Contents/Developer`,
  }) => {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "xcrun"),
      `#!/bin/sh\necho "${developerDir}/usr/bin/xcodebuild"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "xcodebuild"),
      `#!/bin/sh\necho "Xcode ${version}"\necho "Build version ${build}"\n`,
      { mode: 0o755 },
    );
    return spawnSync("bash", [path.join(__dirname, "require-stable-xcode.sh")], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        DEVELOPER_DIR: developerDir,
        XCODE_EXPECTED_VERSION: "27.1",
      },
    });
  };
  assert.equal(run({ version: "27.1", build: "27A9275" }).status, 0);
  // /Applications/Xcode.app is a beta on shuvbot even though its path does not say so.
  const beta = run({
    version: "27.2",
    build: "27B5028f",
    developerDir: `${root}/Xcode.app/Contents/Developer`,
  });
  assert.equal(beta.status, 1);
  assert.match(beta.stderr, /Expected Xcode 27\.1/);
  assert.equal(run({ version: "27.1", build: "27A9275f" }).status, 1);
  assert.equal(
    run({
      version: "27.1",
      build: "27A9275",
      developerDir: `${root}/Xcode-27.2.0-Beta.2.app/Contents/Developer`,
    }).status,
    1,
  );
});

test("a shuvbot attempt still queued after the timeout triggers the hosted fallback", () => {
  const queued = { name: buildJobName(MAC_ARM64_CALLERS[0]), status: "queued" };
  assert.equal(QUEUE_TIMEOUT_SECONDS, 600);
  assert.equal(classifyQueue([], 0), "waiting");
  assert.equal(classifyQueue([queued], QUEUE_TIMEOUT_SECONDS - 1), "waiting");
  assert.equal(classifyQueue([queued], QUEUE_TIMEOUT_SECONDS), "timeout");
  assert.equal(classifyQueue([], QUEUE_TIMEOUT_SECONDS), "timeout");
  for (const status of ["in_progress", "completed"])
    assert.equal(classifyQueue([{ ...queued, status }], QUEUE_TIMEOUT_SECONDS * 2), "picked-up");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-arm64-queue-"));
  const jobs = path.join(root, "jobs.jsonl");
  fs.writeFileSync(jobs, `${JSON.stringify(queued)}\n`);
  const state = (seconds) =>
    spawnSync(
      process.execPath,
      [path.join(__dirname, "macos-arm64-runner-retry.cjs"), "queue-state", jobs, String(seconds)],
      { encoding: "utf8" },
    ).stdout.trim();
  assert.equal(state(30), "waiting");
  assert.equal(state(QUEUE_TIMEOUT_SECONDS), "timeout");
});

test("the attempt the queue fallback cancelled is superseded, not retried or a failure", () => {
  const cancelledByFallback = {
    name: buildJobName(MAC_ARM64_CALLERS[0]),
    conclusion: "cancelled",
    runner_id: 0,
    steps: [],
  };
  const fallback = (conclusion) => ({
    name: buildJobName(QUEUE_FALLBACK_CALLER),
    conclusion,
    runner_id: 7,
    steps: [{ name: "Checkout" }],
  });
  const ok = classifyAttempts([cancelledByFallback, fallback("success")]);
  assert.equal(ok.ok, true);
  assert.equal(ok.attempts[0].reason, "superseded");
  assert.equal(ok.attempts[0].retry, false);
  // Without the fallback, the same job is a runner miss and retries.
  assert.equal(classifyAttempts([cancelledByFallback]).attempts[0].retry, true);
  const failed = classifyAttempts([cancelledByFallback, fallback("failure")]);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "failure");
  // A first attempt that finished stays a success even if the fallback also started.
  assert.equal(
    classifyAttempts([
      { ...cancelledByFallback, conclusion: "success", runner_id: 3, steps: [{ name: "x" }] },
      fallback("cancelled"),
    ]).ok,
    true,
  );
});

test("the workflows wire the queue watch, shared concurrency group and keychain cleanup", () => {
  assert.match(
    workflow,
    /desktop_mac_arm64_queue_fallback:\n {4}name: Desktop \(macOS arm64 queue fallback\)/,
  );
  assert.match(workflow, /needs\.mac_arm64_queue_watch\.outputs\.fallback == 'true'/);
  assert.match(workflow, /queue-state "\$RUNNER_TEMP\/jobs\.jsonl"/);
  assert.match(workflow, /\n {8}desktop_mac_arm64_queue_fallback,\n/);
  assert.match(
    desktop,
    /concurrency:\n {6}group: release-desktop-\$\{\{ github\.run_id \}\}-\$\{\{ inputs\.platform \}\}-\$\{\{ inputs\.arch \}\}\n {6}cancel-in-progress: true/,
  );
  assert.match(
    desktop,
    /Delete temporary signing keychains and keys\n {8}if: always\(\) && inputs\.platform == 'mac'[\s\S]*security delete-keychain[\s\S]*\*\.p8[\s\S]*\*\.provisionprofile/,
  );
  assert.ok(desktop.includes("APP_BUILDER_TMP_DIR: ${{ runner.temp }}"));
});

test("the CLI archive signs with the keychain it imported into, by path", () => {
  const importStep = desktop
    .split("      - name: Import macOS signing certificate for the CLI archive\n")[1]
    .split("\n      - name:")[0];
  assert.ok(importStep.includes("set-key-partition-list -S apple-tool:,apple:,codesign: "));
  assert.ok(importStep.includes('echo "T3CODE_CLI_MAC_SIGN_KEYCHAIN=$keychain"'));
  const listStep = desktop
    .split("      - name: List macOS code signing identity names\n")[1]
    .split("\n      - name:")[0];
  for (const call of [
    'list -p codesigning "$T3CODE_CLI_MAC_SIGN_KEYCHAIN"',
    'list -v -p codesigning "$T3CODE_CLI_MAC_SIGN_KEYCHAIN"',
    "list -p codesigning\n",
    "list -v -p codesigning\n",
  ])
    assert.ok(listStep.includes(call), call);
  const buildStep = desktop
    .split("      - name: Build CLI archive\n")[1]
    .split("\n      - name:")[0];
  assert.match(
    buildStep,
    /unset [^\n]*T3CODE_CLI_MAC_SIGN_IDENTITY T3CODE_CLI_MAC_SIGN_KEYCHAIN\n/,
  );
});

test("the dependency verification the desktop builds download is produced first", () => {
  const download = desktop
    .split("      - name: Download dependency verification\n")[1]
    .split("\n      - name:")[0];
  assert.equal(download.includes("continue-on-error"), false);
  const bundle = workflow.split("  build_bundle:\n")[1].split("\n  desktop:\n")[0];
  assert.match(
    bundle,
    /name: Upload dependency verification\n[\s\S]*name: release-dependency-verification\n\s+path: \$\{\{ runner\.temp \}\}\/pnpm-metadata\/lockfile-verified\.jsonl\n\s+if-no-files-found: error/,
  );
  assert.ok(bundle.includes("pnpm_config_cache_dir: ${{ runner.temp }}/pnpm-metadata"));
});

test("the self-hosted job is allowlisted, starts clean, and never holds Azure secrets on the Mac", () => {
  assert.ok(
    desktop.includes(
      `contains(fromJSON('["schedule","workflow_dispatch"]'), github.event_name) && github.ref == 'refs/heads/main'`,
    ),
  );
  assert.equal(desktop.includes("github.event_name != 'pull_request'"), false);
  const checkout = desktop.indexOf("      - name: Checkout\n");
  const clean = desktop.indexOf("      - name: Clean workspace\n");
  assert.ok(clean !== -1 && clean < checkout);
  // Every Azure secret passed to a step is gated to Windows, except the Windows-only steps.
  const azure = desktop
    .split("\n")
    .filter((line) => /^\s+AZURE_[A-Z_]+: \$\{\{ secrets\./.test(line));
  const gated = desktop
    .split("\n")
    .filter((line) =>
      /^\s+AZURE_[A-Z_]+: \$\{\{ inputs\.platform == 'win' && secrets\./.test(line),
    );
  assert.equal(gated.length, 20);
  // Left ungated: the Windows-only "Prepare Azure Trusted Signing" step's seven secrets.
  assert.equal(azure.length, 7);
  // Every macOS arm64 caller passes the Mac signing secrets by name instead of inheriting all.
  const macSecrets = workflow
    .split("    secrets: &mac_arm64_secrets\n")[1]
    .split("    with:")[0]
    .trim()
    .split("\n")
    .map((line) => line.trim().split(":")[0]);
  assert.deepEqual(macSecrets, [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "MACOS_PROVISIONING_PROFILE",
  ]);
  for (const caller of MAC_ARM64_CALLERS) {
    const job = workflow.split(`    name: ${caller}\n`)[1].split("\n  mac_arm64_")[0];
    assert.match(job, /\n {4}secrets: [&*]mac_arm64_secrets\n/, caller);
    assert.equal(job.includes("secrets: inherit"), false, caller);
  }
});

test("a jobs read retries a transient API failure and keeps the last read when retries run out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-arm64-jobs-"));
  const output = path.join(root, "jobs.jsonl");
  const queued = { name: buildJobName(MAC_ARM64_CALLERS[0]), status: "queued" };
  const gh = fakeGh(root, { failures: 2, jobs: [queued] });
  assert.equal(fetchJobs(output, { env: gh.env, delayMs: 0 }), 3);
  assert.equal(
    gh.args(),
    "api --paginate repos/shuv1337/s2code/actions/runs/41740484868/attempts/1/jobs?per_page=100 --jq .jobs[]",
  );
  assert.deepEqual(readJobsJsonl(output), [queued]);

  fs.rmSync(path.join(root, "calls"));
  const down = fakeGh(root, { failures: 99, jobs: [] });
  assert.throws(
    () => fetchJobs(output, { env: down.env, delayMs: 0, attempts: 3 }),
    /after 3 attempts: HTTP 502: Bad Gateway/,
  );
  assert.equal(down.calls(), 3);
  assert.deepEqual(readJobsJsonl(output), [queued]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("with shuvbot offline, the release falls back to hosted macos-26 and the gate accepts it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-arm64-offline-"));
  const jobs = path.join(root, "jobs.jsonl");
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: gh.env });
  // No shuvbot runner is online, so the first attempt never leaves the queue.
  const queued = { name: buildJobName(MAC_ARM64_CALLERS[0]), status: "queued", runner_id: 0 };
  let gh = fakeGh(root, { failures: 0, jobs: [queued] });
  assert.equal(run("jobs", jobs).status, 0);
  assert.equal(
    run("queue-state", jobs, String(QUEUE_TIMEOUT_SECONDS - 15)).stdout.trim(),
    "waiting",
  );
  assert.equal(run("queue-state", jobs, String(QUEUE_TIMEOUT_SECONDS)).stdout.trim(), "timeout");

  const { fallback } = splitDesktopMatrix({
    include: [{ platform: "mac", arch: "arm64", runner: '["self-hosted","shuvbot-macos"]' }],
  });
  assert.equal(fallback.runner, "macos-26");

  // Starting the fallback cancels the queued attempt through their shared concurrency group.
  fs.rmSync(path.join(root, "calls"));
  gh = fakeGh(root, {
    failures: 0,
    jobs: [
      { ...queued, status: "completed", conclusion: "cancelled", steps: [] },
      {
        name: buildJobName(QUEUE_FALLBACK_CALLER),
        status: "completed",
        conclusion: "success",
        runner_id: 42,
        steps: [{ name: "Checkout" }],
      },
    ],
  });
  assert.equal(run("jobs", jobs).status, 0);
  const gate = run("gate", jobs);
  assert.equal(gate.status, 0, gate.stderr);
  assert.match(gate.stdout, /Desktop \(macOS arm64\): superseded/);
  assert.match(gate.stdout, /Desktop \(macOS arm64 queue fallback\): success/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("every macOS arm64 jobs read goes through the retrying reader", () => {
  assert.equal(/gh api --paginate .*\/jobs/.test(workflow), false);
  // The queue watch keeps waiting on a failed read; the checks and the gate fail closed.
  assert.match(workflow, /retry\.cjs jobs "\$RUNNER_TEMP\/jobs\.jsonl" \|\| echo "::warning::/);
  assert.match(workflow, /retry\.cjs jobs "\$RUNNER_TEMP\/jobs\.jsonl"\n {10}node \S+ attempt/);
  assert.match(workflow, /retry\.cjs jobs "\$RUNNER_TEMP\/jobs\.jsonl"\n {10}node \S+ gate/);
});
