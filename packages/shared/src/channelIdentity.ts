import { DEFAULT_HOME_DIRECTORY, LEGACY_HOME_DIRECTORY } from "./productIdentity.ts";
export const SEPARATE_CHANNEL_INSTALL_MESSAGE =
  "Release channels are separate installations. Install the other channel separately instead of updating this installation across channels.";

export function isSameInstallationChannel(currentVersion: string, targetVersion: string) {
  return (
    resolveChannelIdentity(currentVersion).channel === resolveChannelIdentity(targetVersion).channel
  );
}

/** Installation identity follows the built version, never a mutable updater preference. */
const installationChannel = (version: string) =>
  /^[^-+]+-(?:preview|pr)\./.test(version)
    ? "preview"
    : /^[^-+]+-nightly\./.test(version)
      ? "nightly"
      : "stable";

export function resolveChannelIdentity(version: string) {
  return channelIdentity(version, false);
}

export function resolveLegacyChannelIdentity(version: string) {
  return channelIdentity(version, true);
}

function channelIdentity(version: string, legacy: boolean) {
  const channel = installationChannel(version);
  const suffix = channel === "stable" ? "" : `-${channel}`;
  const product = legacy ? "shuv2code" : "s2code";
  return {
    channel,
    homeDirectory: `${legacy ? LEGACY_HOME_DIRECTORY : DEFAULT_HOME_DIRECTORY}${suffix}`,
    // Keep Electron's encrypted storage at its installed identity through the rename.
    profileDirectory: `shuv2code-v2${suffix}`,
    scheme: `${product}${suffix}`,
    // Existing signed apps, updater ownership, and credentials use this native ID.
    appId: `dev.shuv.shuv2code${channel === "stable" ? "" : `.${channel}`}`,
    executableName: `${product}${suffix}`,
    serviceName: `${product}-v2${suffix}`,
    serviceLabel: `dev.shuv.${product}.v2${channel === "stable" ? "" : `.${channel}`}.service`,
    updateChannel: channel === "preview" ? null : channel === "nightly" ? "nightly" : "latest",
  } as const;
}
