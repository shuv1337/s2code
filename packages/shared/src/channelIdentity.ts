import { DEFAULT_HOME_DIRECTORY } from "./productIdentity.ts";
const CHANNEL_HOME_DIRECTORIES = {
  stable: DEFAULT_HOME_DIRECTORY,
  nightly: `${DEFAULT_HOME_DIRECTORY}-nightly`,
  preview: `${DEFAULT_HOME_DIRECTORY}-preview`,
} as const;
export const SEPARATE_CHANNEL_INSTALL_MESSAGE =
  "Release channels are separate installations. Install the other channel separately instead of updating this installation across channels.";

export function isSameInstallationChannel(currentVersion: string, targetVersion: string) {
  return (
    resolveChannelIdentity(currentVersion).channel === resolveChannelIdentity(targetVersion).channel
  );
}

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
    homeDirectory: CHANNEL_HOME_DIRECTORIES[channel],
    profileDirectory: `shuv2code-v2${suffix}`,
    scheme: `shuv2code${suffix}`,
    appId: `dev.shuv.shuv2code${channel === "stable" ? "" : `.${channel}`}`,
    executableName: `shuv2code${suffix}`,
    serviceName: `shuv2code-v2${suffix}`,
    serviceLabel: `dev.shuv.shuv2code.v2${channel === "stable" ? "" : `.${channel}`}.service`,
    updateChannel: channel === "preview" ? null : channel === "nightly" ? "nightly" : "latest",
  } as const;
}
