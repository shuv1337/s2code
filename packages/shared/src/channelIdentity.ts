import { DEFAULT_HOME_DIRECTORY } from "./productIdentity.ts";

/** Installation identity follows the built version, never a mutable updater preference. */
export function resolveChannelIdentity(version: string) {
  const channel = /^[^-+]+-(?:preview|pr)\./.test(version)
    ? "preview"
    : /^[^-+]+-nightly\./.test(version)
      ? "nightly"
      : "stable";
  const suffix = channel === "stable" ? "" : `-${channel}`;
  return {
    channel,
    homeDirectory: `${DEFAULT_HOME_DIRECTORY}${suffix}`,
    profileDirectory: `shuv2code-v2${suffix}`,
    scheme: `shuv2code${suffix}`,
    appId: `dev.shuv.shuv2code${channel === "stable" ? "" : `.${channel}`}`,
    executableName: `shuv2code${suffix}`,
    serviceName: `shuv2code-v2${suffix}`,
    serviceLabel: `dev.shuv.shuv2code.v2${channel === "stable" ? "" : `.${channel}`}.service`,
    updateChannel: channel === "preview" ? null : channel === "nightly" ? "nightly" : "latest",
  } as const;
}
