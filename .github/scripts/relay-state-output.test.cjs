const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const releaseWorkflow = readFileSync(join(__dirname, "../workflows/release.yml"), "utf8");
const desktopWorkflow = readFileSync(join(__dirname, "../workflows/release-desktop.yml"), "utf8");

test("release does not read or publish production relay tracing config", () => {
  assert.doesNotMatch(releaseWorkflow, /- name: Read production relay tracing config\n/);
  assert.doesNotMatch(releaseWorkflow, /relay-client-tracing-config/);
  assert.doesNotMatch(releaseWorkflow, /relay_client_tracing/);
});

test("desktop release workflow does not accept or load relay client tracing config", () => {
  assert.doesNotMatch(desktopWorkflow, /relay_client_tracing/);
  assert.doesNotMatch(desktopWorkflow, /relay-client-tracing-config/);
  assert.doesNotMatch(desktopWorkflow, /T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN/);
});
