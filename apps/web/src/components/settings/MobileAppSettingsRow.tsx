import { T, useGT } from "gt-react";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

/** The iOS beta is a private TestFlight with no public join link; access is by invite. */
const TESTFLIGHT_URL = "https://testflight.apple.com/";

export function MobileAppSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={gt(
        "S2Code for iPhone and iPad is in a private TestFlight beta. Email shuv@shuv.dev for access.",
      )}
      control={
        <Button
          render={<a href={TESTFLIGHT_URL} target="_blank" rel="noreferrer noopener" />}
          size="sm"
          variant="outline"
        >
          <T>Open TestFlight</T>
        </Button>
      }
    />
  );
}
