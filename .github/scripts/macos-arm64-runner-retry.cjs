const FS = require("node:fs");

// GitHub cancels a hosted job that never receives a runner after about 15 minutes.
// timeout-minutes does not extend that wait; a later job is a new request.
const MAC_ARM64_CALLERS = [
  "Desktop (macOS arm64)",
  "Desktop (macOS arm64 retry 2)",
  "Desktop (macOS arm64 retry 3)",
  "Desktop (macOS arm64 retry 4)",
  "Desktop (macOS arm64 retry 5)",
  "Desktop (macOS arm64 retry 6)",
];

const buildJobName = (callerName) => `${callerName} / Build macOS arm64`;

function splitDesktopMatrix(matrix) {
  if (!matrix || !Array.isArray(matrix.include))
    throw new Error("Desktop matrix is missing include.");
  const mac = matrix.include.filter(
    (target) =>
      target.platform === "mac" && target.arch === "arm64" && target.runner === "macos-26",
  );
  const rest = matrix.include.filter(
    (target) => !(target.platform === "mac" && target.arch === "arm64"),
  );
  if (mac.length !== 1)
    throw new Error(`Expected one macOS arm64 desktop target, found ${mac.length}.`);
  return { mac: mac[0], rest: { include: rest } };
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

function classifyAttempt(job) {
  if (!job) return { retry: false, ok: false, reason: "missing" };
  if (job.conclusion === "success") return { retry: false, ok: true, reason: "success" };
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const neverAcquired =
    steps.length === 0 &&
    (job.runner_id === 0 || job.runner_id == null) &&
    (job.conclusion === "cancelled" || job.conclusion === "failure");
  if (neverAcquired) return { retry: true, ok: false, reason: "not-acquired" };
  return { retry: false, ok: false, reason: job.conclusion || "failed" };
}

function classifyCaller(jobs, callerName) {
  return {
    callerName,
    ...classifyAttempt(jobs.find((job) => job.name === buildJobName(callerName))),
  };
}

function classifyAttempts(jobs, callerNames = MAC_ARM64_CALLERS) {
  const attempts = callerNames.map((callerName) => classifyCaller(jobs, callerName));
  if (attempts.some((attempt) => attempt.ok)) return { ok: true, reason: "success", attempts };
  const realFailure = attempts.find((attempt) => !attempt.retry && attempt.reason !== "missing");
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
    ]);
    return;
  }
  const jobs = readJobsJsonl(process.argv[3]);
  if (command === "attempt") {
    const callerName = process.env.CALLER_NAME;
    if (!callerName) throw new Error("CALLER_NAME is required.");
    const decision = classifyCaller(jobs, callerName);
    console.log(`macOS arm64 acquire ${callerName}: ${decision.reason}`);
    if (decision.retry)
      console.log(
        "::notice::macOS arm64 hosted runner was not acquired. Requesting another macos-26 runner.",
      );
    writeGithubOutput([["retry", decision.retry ? "true" : "false"]]);
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
        ? "GitHub hosted macos-26 never assigned a runner. Each attempt waits about 15 minutes, then GitHub cancels it with runner_id 0. timeout-minutes does not extend that wait. A runner may still never arrive."
        : `macOS arm64 desktop build did not succeed (${decision.reason}).`,
    );
    process.exitCode = 1;
    return;
  }
  throw new Error("Use split-matrix, attempt <jobs.jsonl>, or gate <jobs.jsonl>.");
}

module.exports = {
  MAC_ARM64_CALLERS,
  buildJobName,
  classifyAttempt,
  classifyAttempts,
  classifyCaller,
  readJobsJsonl,
  splitDesktopMatrix,
};

if (require.main === module) main();
