import bundle from "../../gnome-extension/bundle.json" with { type: "json" };
import { resolveLinuxDesktopId } from "../app/DesktopEarlyElectronStartup.ts";

export const GNOME_CAPTURE_UUID = bundle.uuid;
export const GNOME_CAPTURE_FILES = bundle.files;
export const GNOME_CAPTURE_DBUS_NAME = bundle.dbusName;
export const GNOME_CAPTURE_DBUS_PATH = bundle.dbusPath;
export const LEGACY_GNOME_CAPTURE_DBUS_NAME = "io.github.shuv1337.shuv2code.SnapShot";
export const LEGACY_GNOME_CAPTURE_DBUS_PATH = "/io/github/shuv1337/shuv2code/SnapShot";

/** Match the channel identities used by Electron and the installed desktop entries. */
export function gnomeCaptureClientName(appId: string, serviceName = GNOME_CAPTURE_DBUS_NAME) {
  const suffix =
    appId === resolveLinuxDesktopId(true)
      ? ".Development"
      : appId === resolveLinuxDesktopId(false, "0.0.0-nightly.1")
        ? ".Nightly"
        : appId === resolveLinuxDesktopId(false, "0.0.0-preview.1")
          ? ".Preview"
          : "";
  return `${serviceName}.Client${suffix}`;
}
