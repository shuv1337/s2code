// @effect-diagnostics nodeBuiltinImport:off -- Offline guard checks never import provisioning providers.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";

it.each([undefined, "1"])(
  "refuses relay stack construction even with the former verification flag set to %s",
  (flag) => {
    const source = NodeFS.readFileSync(new URL("../alchemy.run.ts", import.meta.url), "utf8")
      .replace(/^import .*;\n/gm, "")
      .replace("export default ", "");
    const stack = vi.fn();
    expect(() =>
      NodeVM.runInNewContext(source, {
        process: { env: { FORK_HOSTED_DEPLOYMENT_VERIFIED: flag } },
        Alchemy: { Stack: stack },
      }),
    ).toThrow("Hosted relay deployment is not supported in this fork.");
    expect(stack).not.toHaveBeenCalled();
  },
);

it.each(["web-preview.yml", "deploy-relay.yml"])(
  "keeps %s notice-only without secrets or executable deployment steps",
  (name) => {
    const source = NodeFS.readFileSync(
      new URL(`../../../.github/workflows/${name}`, import.meta.url),
      "utf8",
    );
    expect(source).toContain("::notice::");
    expect(source).toContain("GITHUB_STEP_SUMMARY");
    expect(source).not.toMatch(
      /secrets:|secrets\.|uses:|id-token:|environment:|hosted-preflight|FORK_HOSTED_DEPLOYMENT_VERIFIED/,
    );
    // The only shell actions in either workflow are the visible notices/summaries.
    const lines = source.split("run: |\n")[1]!.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.trim()).toMatch(/^echo '/);
  },
);
