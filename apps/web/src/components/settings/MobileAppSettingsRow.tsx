import { PRODUCT_TESTFLIGHT_URL } from "@t3tools/shared/productIdentity";
import { T } from "gt-react";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const LINK_CLASS = "underline underline-offset-2 hover:text-foreground";

export function MobileAppSettingsRow() {
  const searchableSetting = useSearchableSetting();
  return (
    <SettingsRow
      {...searchableSetting("mobile-app")}
      description={
        <T>
          The iOS app is in a public{" "}
          <a
            href={PRODUCT_TESTFLIGHT_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={LINK_CLASS}
          >
            TestFlight
          </a>{" "}
          beta.
        </T>
      }
    />
  );
}
