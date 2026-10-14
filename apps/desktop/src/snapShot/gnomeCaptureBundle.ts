import bundle from "../../gnome-extension/bundle.json" with { type: "json" };
import { resolveLinuxDesktopEntryName } from "../app/DesktopEarlyElectronStartup.ts";

export const GNOME_CAPTURE_UUID = bundle.uuid;
export const GNOME_CAPTURE_FILES = bundle.files;
export const GNOME_CAPTURE_DBUS_NAME = bundle.dbusName;
export const GNOME_CAPTURE_DBUS_PATH = bundle.dbusPath;

/** Match the packaged/development identities currently returned by the desktop entry resolver. */
export function gnomeCaptureClientName(appId: string) {
  const developmentAppId = resolveLinuxDesktopEntryName(true).replace(/\.desktop$/, "");
  const suffix = appId === developmentAppId ? ".Development" : "";
  return `${GNOME_CAPTURE_DBUS_NAME}.Client${suffix}`;
}
