// @effect-diagnostics nodeBuiltinImport:off -- Executes the actual CI reconciliation shell with offline command fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/mobile-eas-production.yml", import.meta.url),
  "utf8",
);
const script = workflow
  .split("      - id: reconcile\n")[1]!
  .split("        run: |\n")[1]!
  .split("\n      - name: Clean")[0]!
  .replace(/^          /gm, "");
const fixtures = `
npx() { echo '{}'; }
git() { echo fixture-commit; }
eas() {
  case "$1" in
    fingerprint:generate) echo '{}' ;;
    build:list) echo '[]' ;;
    build|update) echo "$*" >> "$TEST_COMMANDS" ;;
    *) return 99 ;;
  esac
}
jq() {
  cat >/dev/null
  case "$*" in
    *'.version'*) echo 2.0.0 ;;
    *'.hash'*) echo fixture-fingerprint ;;
    *'FINISHED'*) echo "$TEST_FINISHED" ;;
    *'IN_QUEUE'*) echo "$TEST_ACTIVE" ;;
    *'ERRORED'*) echo 0 ;;
    *'appVersion'*) echo "$TEST_VERSION" ;;
    *) return 99 ;;
  esac
}
`;
function reconcile(settings: Record<string, string>) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-reconcile-"));
  const summary = NodePath.join(directory, "summary");
  const commands = NodePath.join(directory, "commands");
  try {
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-eu", "-o", "pipefail", "-c", fixtures + script],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_STEP_SUMMARY: summary,
          TEST_COMMANDS: commands,
          TEST_FINISHED: "1",
          TEST_ACTIVE: "0",
          TEST_VERSION: "2.0.0",
          MOBILE_UPDATES_ENABLED: "0",
          ...settings,
        },
      },
    );
    expect(result.stderr).toBe("");
    return {
      status: result.status,
      summary: NodeFS.existsSync(summary) ? NodeFS.readFileSync(summary, "utf8") : "",
      commands: NodeFS.existsSync(commands) ? NodeFS.readFileSync(commands, "utf8") : "",
    };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}
describe("production push delivery reconciliation", () => {
  it("fails with a manual binary-release action rather than dropping JS-only changes when OTA is off", () => {
    const result = reconcile({});
    expect(result.status).toBe(1);
    expect(result.summary).toContain("ios: OTA is disabled");
    expect(result.summary).toContain("android: OTA is disabled");
    expect(result.summary).toContain("mode=build, profile=production");
    expect(result.commands).toBe("");
  });
  it("also requires manual release when only an older in-flight binary matches", () => {
    const result = reconcile({ TEST_FINISHED: "0", TEST_ACTIVE: "1" });
    expect(result.status).toBe(1);
    expect(result.summary).toContain("mode=build, profile=production");
    expect(result.commands).toBe("");
  });
  it.each([{ TEST_FINISHED: "0" }, { TEST_VERSION: "1.0.0" }])(
    "still schedules native/version binary releases with OTA off (%j)",
    (settings) => {
      const result = reconcile(settings);
      expect(result.status).toBe(0);
      expect(result.commands).toContain("build --platform ios --profile production --auto-submit");
      expect(result.commands).toContain(
        "build --platform android --profile production --auto-submit",
      );
      expect(result.commands).not.toContain("update");
    },
  );
  it("preserves explicitly enabled OTA delivery for finished matching binaries", () => {
    const result = reconcile({ MOBILE_UPDATES_ENABLED: "1" });
    expect(result.status).toBe(0);
    expect(result.commands).toContain(
      "update --channel production --environment production --platform ios",
    );
    expect(result.commands).toContain(
      "update --channel production --environment production --platform android",
    );
    expect(result.commands).not.toContain("build --platform");
  });
});
