// @effect-diagnostics nodeBuiltinImport:off -- Guard test inspects tracked repository source/config files directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../..");

const SCANNED_PATHSPECS = [
  "apps/server/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/mobile/src",
  "packages",
  "apps/mobile/app.config.ts",
  "apps/mobile/package.json",
  "apps/server/vite.config.ts",
  "apps/web/vite.config.ts",
  "scripts/lib/public-config.ts",
  ".env.example",
  ".github/workflows/release-desktop.yml",
  ".github/workflows/release.yml",
] as const;

const TEST_FILE_PATTERN =
  /(?:^|\/)(?:test|tests|testUtils|testkit|__tests__)\/|\.(?:test|spec|renders)\.[^/]+$/u;

const CLEANUP_REMOVE_ANALYTICS_DEVICE_ID =
  /localStorage\.removeItem\(\s*["']t3code:analytics-device-id["']\s*\)/u;

interface ForbiddenPattern {
  readonly label: string;
  readonly pattern: RegExp;
  readonly allowLine?: (filePath: string, line: string) => boolean;
}

const FORBIDDEN_PATTERNS: ReadonlyArray<ForbiddenPattern> = [
  { label: "ingest.t3.codes", pattern: /ingest\.t3\.codes/iu },
  { label: "api.axiom.co", pattern: /api\.axiom\.co/iu },
  { label: "x-axiom-dataset", pattern: /x-axiom-dataset/iu },
  { label: "posthog", pattern: /posthog/iu },
  {
    label: "expo-observe",
    pattern: /expo-observe/iu,
    // The relay OpenAPI route stays declared so old mobile builds receive 503 cleanly.
    allowLine: (filePath) => filePath === "packages/contracts/src/relay.ts",
  },
  {
    label: "analytics-device-id",
    pattern: /analytics-device-id/iu,
    // Allow one startup cleanup line that deletes stale IDs from older installs.
    allowLine: (filePath, line) =>
      filePath === "apps/web/src/connection/platform.ts" &&
      CLEANUP_REMOVE_ANALYTICS_DEVICE_ID.test(line),
  },
  {
    label: 'searchParams.set("clientOwner"',
    pattern: /searchParams\.set\(\s*["']clientOwner["']|clientOwner=/iu,
  },
  { label: "t3.codes/privacy-policy", pattern: /t3\.codes\/privacy-policy/iu },
];

function listTrackedRuntimeFiles(): ReadonlyArray<string> {
  const output = NodeChildProcess.execFileSync("git", ["ls-files", "--", ...SCANNED_PATHSPECS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((filePath) => {
      if (!filePath || TEST_FILE_PATTERN.test(filePath)) return false;
      if (filePath.startsWith("packages/")) {
        return /^packages\/[^/]+\/src\//u.test(filePath);
      }
      return true;
    });
}

describe("zero-telemetry guard", () => {
  it("contains no forbidden analytics, tracing, crash-reporting, or upstream privacy references", () => {
    const files = listTrackedRuntimeFiles();
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<string> = [];
    for (const filePath of files) {
      const fullPath = NodePath.join(REPO_ROOT, filePath);
      if (!NodeFS.existsSync(fullPath)) continue;
      const lines = NodeFS.readFileSync(fullPath, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        for (const rule of FORBIDDEN_PATTERNS) {
          if (rule.pattern.test(line) && !rule.allowLine?.(filePath, line)) {
            violations.push(`${filePath}:${index + 1} matched ${rule.label}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
