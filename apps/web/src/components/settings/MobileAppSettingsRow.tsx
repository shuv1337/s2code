import { useGT } from "gt-react";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function MobileAppSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={gt("Fork mobile apps are not available yet.")}
      control={null}
    />
  );
}
