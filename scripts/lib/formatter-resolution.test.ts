// @effect-diagnostics nodeBuiltinImport:off - Checks the installed formatter this checkout resolves.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");

it("resolves the formatter from this checkout and lets it load vite-plus", () => {
  const oxfmtMain = NodeModule.createRequire(NodePath.join(repoRoot, "package.json")).resolve(
    "oxfmt",
    { paths: [repoRoot] },
  );
  const oxfmtPackageDir = NodePath.dirname(NodePath.dirname(oxfmtMain));
  // `vp fmt` runs this oxfmt CLI, which imports `vite-plus` for the Vite config.
  // A resolution that walks past the checkout finds an oxfmt that cannot see it.
  expect(NodePath.relative(repoRoot, oxfmtPackageDir).startsWith("..")).toBe(false);
  expect(() =>
    NodeModule.createRequire(NodePath.join(oxfmtPackageDir, "package.json")).resolve("vite-plus"),
  ).not.toThrow();
});
