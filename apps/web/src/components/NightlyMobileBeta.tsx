import { parseSemver } from "@t3tools/shared/semver";
import { resolveProductDownload } from "@t3tools/shared/productIdentity";
import { APP_VERSION, HOSTED_APP_CHANNEL } from "../branding";
import { SettingsRow } from "./settings/settingsLayout";

export const IS_NIGHTLY_BUILD =
  parseSemver(APP_VERSION)?.prerelease[0] === "nightly" || HOSTED_APP_CHANNEL === "nightly";

export function NightlyMobileBetaRow() {
  return (
    <SettingsRow
      id="nightly-mobile-beta"
      title="Mobile app"
      description={resolveProductDownload(true).label}
      control={null}
    />
  );
}
