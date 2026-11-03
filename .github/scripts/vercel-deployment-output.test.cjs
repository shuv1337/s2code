const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

// Hosted web and marketing deployment are disabled in the fork. Upstream
// merges must not bring the Vercel deploy steps back into these workflows.
for (const file of ["release.yml", "web-preview.yml"]) {
  test(`${file} has no Vercel deployment step`, () => {
    const workflow = readFileSync(join(__dirname, "../workflows", file), "utf8");
    assert.doesNotMatch(workflow, /name: (?:Build staged deployment|Deploy preview)\n/);
    assert.doesNotMatch(workflow, /VERCEL_|vercel (?:deploy|build)/i);
  });
}
