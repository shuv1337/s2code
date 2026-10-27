import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { resolveChannelIdentity } from "@t3tools/shared/channelIdentity";

// Preview builds have their own installation identity and ship without an update
// feed, so the channel a preview install reports is cosmetic.
export function isNightlyDesktopVersion(version: string): boolean {
  return resolveChannelIdentity(version).channel === "nightly";
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return resolveChannelIdentity(appVersion).updateChannel ?? "latest";
}
