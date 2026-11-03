import { isolateGitEnv } from "@t3tools/shared/testing/gitEnv";

// Drops inherited repository selectors and GIT_CONFIG_* first, then overrides autocrlf, signing and
// init-branch settings through env so every git child gets stable fixtures.
isolateGitEnv();

const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

process.env.GIT_CONFIG_COUNT = String(entries.length);
entries.forEach(([key, value], index) => {
  process.env[`GIT_CONFIG_KEY_${index}`] = key;
  process.env[`GIT_CONFIG_VALUE_${index}`] = value;
});
