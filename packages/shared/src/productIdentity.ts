/** Fork-owned install identity; upstream protocol names intentionally stay stable. */
// Never open the old fork's divergent V1 migration ledger by default.
export const DEFAULT_HOME_DIRECTORY = ".shuv2code-v2";
export const PRODUCT_ID = "shuv2code";
export const PRODUCT_DBUS_PREFIX = "io.github.shuv1337.shuv2code";
export const KDE_CAPTURE_HELPER_EXECUTABLE = `${PRODUCT_ID}-kde-snap-shot`;
