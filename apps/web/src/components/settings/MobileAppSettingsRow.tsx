import { resolveProductDownload } from "@t3tools/shared/productIdentity";

import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function MobileAppSettingsRow() {
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={resolveProductDownload(true).label}
      control={null}
    />
  );
}
