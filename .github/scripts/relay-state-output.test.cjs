const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

// The fork never deploys the production relay, so release.yml has no relay
// state to read tracing config from. release-desktop.yml would wait for a
// `relay-client-tracing-config` artifact that no job uploads.
const workflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");

test("release does not read or publish production relay tracing config", () => {
  assert.doesNotMatch(workflow, /- name: Read production relay tracing config\n/);
  assert.doesNotMatch(workflow, /relay-client-tracing-config/);
});

test("every desktop build opts out of relay client tracing", () => {
  const values = Array.from(
    workflow.matchAll(/^\s+relay_client_tracing: (.*)$/gm),
    (match) => match[1],
  );
  assert.ok(values.length > 0, "Expected release.yml to set relay_client_tracing");
  assert.deepEqual(new Set(values), new Set(["false"]));
});
