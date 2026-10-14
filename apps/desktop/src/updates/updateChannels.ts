import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";

// Preview builds are the maintainers' test train, cut by hand from unreleased
// branches to exercise the release flow. They have their own installation
// identity and are packaged without an update feed (see
// isDesktopPreviewVersion in scripts/build-desktop-artifact.ts), so the
// channel a preview install reports is cosmetic: it never checks for updates
// and no updater feed ever lists a preview release.
export function isNightlyDesktopVersion(version: string): boolean {
  return resolveChannelIdentity(version).channel === "nightly";
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return resolveChannelIdentity(appVersion).updateChannel ?? "latest";
}
