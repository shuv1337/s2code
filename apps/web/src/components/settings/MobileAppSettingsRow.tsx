import { PRODUCT_BETA_ACCESS_EMAIL, PRODUCT_TESTFLIGHT_URL } from "@t3tools/shared/productIdentity";
import { T, Var } from "gt-react";
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
          The mobile apps are in a private{" "}
          <a
            href={PRODUCT_TESTFLIGHT_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={LINK_CLASS}
          >
            TestFlight
          </a>{" "}
          beta. Email{" "}
          <a href={`mailto:${PRODUCT_BETA_ACCESS_EMAIL}`} className={LINK_CLASS}>
            <Var>{PRODUCT_BETA_ACCESS_EMAIL}</Var>
          </a>{" "}
          for access.
        </T>
      }
    />
  );
}
