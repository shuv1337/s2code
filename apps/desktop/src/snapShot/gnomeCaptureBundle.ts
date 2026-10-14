import bundle from "../../gnome-extension/bundle.json" with { type: "json" };

export const GNOME_CAPTURE_UUID = bundle.uuid;
export const GNOME_CAPTURE_FILES = bundle.files;
export const GNOME_CAPTURE_DBUS_NAME = bundle.dbusName;
export const GNOME_CAPTURE_DBUS_PATH = bundle.dbusPath;

/** Separate callers let fork channels coexist without authorizing upstream clients. */
export function gnomeCaptureClientName(appId: string) {
  const suffix = appId.endsWith(".Development")
    ? ".Development"
    : appId.endsWith(".nightly")
      ? ".nightly"
      : appId.endsWith(".preview")
        ? ".preview"
        : "";
  return `${GNOME_CAPTURE_DBUS_NAME}.Client${suffix}`;
}
