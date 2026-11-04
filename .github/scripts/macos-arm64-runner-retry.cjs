const { spawnSync } = require("node:child_process");
const FS = require("node:fs");

// The build runs on the self-hosted shuvbot runner (scripts/lib/fork-release.ts). If
// shuvbot never picks it up, one hosted build replaces it. GitHub cancels a hosted job
// that never receives a runner after about 15 minutes; timeout-minutes does not extend
// that wait.
const HOSTED_FALLBACK_RUNNER = "macos-26";
// If shuvbot has not picked the first attempt up by then, release.yml starts a hosted
// attempt, which cancels the queued one through their shared concurrency group.
const QUEUE_TIMEOUT_SECONDS = 600;
const QUEUE_FALLBACK_CALLER = "Desktop (macOS arm64 queue fallback)";
const MAC_ARM64_CALLERS = ["Desktop (macOS arm64)", QUEUE_FALLBACK_CALLER];

const buildJobName = (callerName) => `${callerName} / Build macOS arm64`;

// macOS arm64 and Windows x64 each get their own job in release.yml.
function splitDesktopMatrix(matrix) {
  if (!matrix || !Array.isArray(matrix.include))
    throw new Error("Desktop matrix is missing include.");
  const take = (platform, arch, label) => {
    const found = matrix.include.filter(
      (target) => target.platform === platform && target.arch === arch,
    );
    if (found.length !== 1)
      throw new Error(`Expected one ${label} desktop target, found ${found.length}.`);
    return found[0];
  };
  const mac = take("mac", "arm64", "macOS arm64");
  const win = take("win", "x64", "Windows x64");
  return {
    mac,
    fallback: { ...mac, runner: HOSTED_FALLBACK_RUNNER },
    win,
    rest: { include: matrix.include.filter((target) => target !== mac && target !== win) },
  };
}

const JOBS_FETCH_ATTEMPTS = 4;
const JOBS_FETCH_DELAY_MS = 5000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The jobs API intermittently answers 5xx. A failed read leaves outputPath untouched.
function fetchJobs(
  outputPath,
  { env = process.env, attempts = JOBS_FETCH_ATTEMPTS, delayMs = JOBS_FETCH_DELAY_MS } = {},
) {
  const endpoint = `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`;
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("gh", ["api", "--paginate", endpoint, "--jq", ".jobs[]"], {
      encoding: "utf8",
      env,
    });
    if (result.status === 0) {
      FS.writeFileSync(outputPath, result.stdout);
      return attempt;
    }
    const reason = (result.error?.message ?? result.stderr ?? "").trim().split("\n").pop();
    if (attempt >= attempts)
      throw new Error(`Could not read this run's jobs after ${attempts} attempts: ${reason}`);
    console.log(`::warning::Reading this run's jobs failed (attempt ${attempt}): ${reason}`);
    sleepSync(delayMs * attempt);
  }
}

function readJobsJsonl(path) {
  const jobs = [];
  for (const line of FS.readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const value = JSON.parse(trimmed);
    if (Array.isArray(value)) jobs.push(...value);
    else if (value && Array.isArray(value.jobs)) jobs.push(...value.jobs);
    else jobs.push(value);
  }
  return jobs;
}

const NOT_ACQUIRED_ANNOTATION = "not acquired by Runner of type hosted";

function annotationMessages(job) {
  if (!Array.isArray(job.annotations)) return null;
  return job.annotations.map((note) => String(note?.message ?? note));
}

// Only a job GitHub cancelled before assigning a hosted runner. A build that
// started, a plain failure, or a missing steps array is a real failure.
function neverAssignedHostedRunner(job) {
  if (!job || job.conclusion !== "cancelled" || job.runner_id !== 0) return false;
  if (!Array.isArray(job.steps) || job.steps.length !== 0) return false;
  const messages = annotationMessages(job);
  if (messages === null) return true;
  return messages.some((message) => message.includes(NOT_ACQUIRED_ANNOTATION));
}

function classifyAttempt(job) {
  if (!job) return { retry: false, ok: false, reason: "missing" };
  if (job.conclusion === "success") return { retry: false, ok: true, reason: "success" };
  if (neverAssignedHostedRunner(job)) return { retry: true, ok: false, reason: "not-acquired" };
  return { retry: false, ok: false, reason: job.conclusion || "failed" };
}

const queueFallbackStarted = (jobs) =>
  jobs.some((job) => job.name === buildJobName(QUEUE_FALLBACK_CALLER));

// "waiting" until the first attempt has a runner; "timeout" once the wait is over.
function classifyQueue(jobs, elapsedSeconds) {
  const job = jobs.find((entry) => entry.name === buildJobName(MAC_ARM64_CALLERS[0]));
  if (job && (job.status === "in_progress" || job.status === "completed")) return "picked-up";
  return elapsedSeconds >= QUEUE_TIMEOUT_SECONDS ? "timeout" : "waiting";
}

function classifyCaller(jobs, callerName) {
  const attempt = classifyAttempt(jobs.find((job) => job.name === buildJobName(callerName)));
  // The queue fallback cancelled the first attempt; its cancellation is not a runner miss.
  if (callerName === MAC_ARM64_CALLERS[0] && !attempt.ok && queueFallbackStarted(jobs))
    return { callerName, retry: false, ok: false, reason: "superseded" };
  return { callerName, ...attempt };
}

function classifyAttempts(jobs, callerNames = MAC_ARM64_CALLERS) {
  const attempts = callerNames.map((callerName) => classifyCaller(jobs, callerName));
  if (attempts.some((attempt) => attempt.ok)) return { ok: true, reason: "success", attempts };
  const realFailure = attempts.find(
    (attempt) => !attempt.retry && attempt.reason !== "missing" && attempt.reason !== "superseded",
  );
  if (realFailure) return { ok: false, reason: realFailure.reason, attempts };
  if (attempts.some((attempt) => attempt.retry))
    return { ok: false, reason: "not-acquired", attempts };
  return { ok: false, reason: "missing", attempts };
}

function writeGithubOutput(entries) {
  const body = `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
  if (!process.env.GITHUB_OUTPUT) {
    process.stdout.write(body);
    return;
  }
  FS.appendFileSync(process.env.GITHUB_OUTPUT, body);
}

function main() {
  const command = process.argv[2];
  if (command === "split-matrix") {
    const split = splitDesktopMatrix(JSON.parse(process.env.MATRIX));
    writeGithubOutput([
      ["matrix_rest", JSON.stringify(split.rest)],
      ["matrix_mac_arm64", JSON.stringify(split.mac)],
      ["matrix_mac_arm64_fallback", JSON.stringify(split.fallback)],
      ["matrix_win_x64", JSON.stringify(split.win)],
    ]);
    return;
  }
  if (command === "jobs") {
    fetchJobs(process.argv[3]);
    return;
  }
  const jobs = readJobsJsonl(process.argv[3]);
  if (command === "queue-state") {
    console.log(classifyQueue(jobs, Number(process.argv[4])));
    return;
  }
  if (command === "gate") {
    const decision = classifyAttempts(jobs);
    for (const attempt of decision.attempts)
      console.log(`${attempt.callerName}: ${attempt.reason}`);
    if (decision.ok) return;
    const acquired = decision.reason === "not-acquired";
    console.error(
      acquired
        ? "No macOS arm64 attempt was assigned a runner. A hosted attempt waits about 15 minutes, then GitHub cancels it with runner_id 0. timeout-minutes does not extend that wait. A runner may still never arrive."
        : `macOS arm64 desktop build did not succeed (${decision.reason}).`,
    );
    process.exitCode = 1;
    return;
  }
  throw new Error(
    "Use split-matrix, jobs <jobs.jsonl>, gate <jobs.jsonl>, or queue-state <jobs.jsonl> <seconds>.",
  );
}

module.exports = {
  HOSTED_FALLBACK_RUNNER,
  QUEUE_FALLBACK_CALLER,
  QUEUE_TIMEOUT_SECONDS,
  MAC_ARM64_CALLERS,
  NOT_ACQUIRED_ANNOTATION,
  buildJobName,
  classifyAttempt,
  classifyAttempts,
  classifyCaller,
  classifyQueue,
  fetchJobs,
  neverAssignedHostedRunner,
  readJobsJsonl,
  splitDesktopMatrix,
};

if (require.main === module) main();
