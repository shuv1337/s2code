// @effect-diagnostics nodeBuiltinImport:off -- Disposable Git fixtures exercise the same committed-tree comparison used by CI.
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { mobileContentDelivered } from "./mobile-content-delivered.ts";

function fixture(
  run: (
    repository: string,
    commit: (file?: string, content?: string) => string,
    builtCommit: string,
  ) => void,
) {
  const repository = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-content-test-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file: string, content: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repository, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repository, file), content);
  };
  const commit = (file?: string, content = "changed") => {
    if (file) write(file, content);
    git("add", ".");
    git("commit", "--quiet", "--allow-empty", "-m", "fixture", "--no-verify");
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--quiet");
    git("config", "user.name", "Mobile fixture");
    git("config", "user.email", "mobile-fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", ".git/no-hooks");
    write(
      "apps/mobile/package.json",
      JSON.stringify({ name: "mobile", dependencies: { "@fixture/runtime": "workspace:*" } }),
    );
    write("apps/mobile/src/app.ts", "original app");
    write(
      "packages/runtime/package.json",
      JSON.stringify({
        name: "@fixture/runtime",
        dependencies: { "@fixture/shared": "workspace:*" },
        devDependencies: { "@fixture/test-tools": "workspace:*" },
      }),
    );
    write("packages/shared/package.json", JSON.stringify({ name: "@fixture/shared" }));
    write("packages/not-bundled/package.json", JSON.stringify({ name: "@fixture/not-bundled" }));
    write("packages/test-tools/package.json", JSON.stringify({ name: "@fixture/test-tools" }));
    write("packages/watch-native/Package.swift", "native watch package");
    run(repository, commit, commit());
  } finally {
    NodeFS.rmSync(repository, { recursive: true, force: true });
  }
}
describe("finished binary mobile content comparison", () => {
  it("recognizes an already-built commit despite generated/uncommitted CI configuration", () =>
    fixture((repository, _commit, built) => {
      NodeFS.writeFileSync(
        NodePath.join(repository, "apps/mobile/eas.json"),
        "generated submission paths",
      );
      expect(mobileContentDelivered(repository, [built])).toBe(true);
    }));
  it.each([
    "scripts/unrelated.ts",
    "packages/not-bundled/src/server.ts",
    "packages/test-tools/src/testing.ts",
    "apps/web/src/app.ts",
  ])("accepts unchanged mobile inputs after an unrelated %s commit", (file) =>
    fixture((repository, commit, built) => {
      commit(file);
      expect(mobileContentDelivered(repository, [built])).toBe(true);
    }),
  );
  it.each([
    "apps/mobile/src/app.ts",
    "packages/runtime/src/client.ts",
    "packages/shared/src/value.ts",
    "scripts/lib/third-party-licenses.ts",
    "scripts/lib/mobile-release-identity.ts",
    "pnpm-lock.yaml",
    "assets/mobile-icon.png",
    "packages/watch-native/Package.swift",
  ])("requires a release for changed mobile input %s", (file) =>
    fixture((repository, commit, built) => {
      commit(file);
      expect(mobileContentDelivered(repository, [built])).toBe(false);
    }),
  );
  it("accepts a matching content revision even if other matching binaries are older", () =>
    fixture((repository, commit, older) => {
      const delivered = commit("apps/mobile/src/app.ts");
      commit("scripts/unrelated.ts");
      expect(mobileContentDelivered(repository, [older, delivered])).toBe(true);
    }));
  it("does not treat missing, invalid or unavailable build revisions as delivered", () =>
    fixture((repository, commit, built) => {
      commit("apps/mobile/src/app.ts");
      for (const revisions of [[], [""], ["--all"], ["ab".repeat(20)], [built]])
        expect(mobileContentDelivered(repository, revisions)).toBe(false);
    }));
});
