/** Fork-owned install identity; upstream protocol names intentionally stay stable. */
// Never open the old fork's divergent V1 migration ledger by default.
export const DEFAULT_HOME_DIRECTORY = ".s2code-v2";
export const LEGACY_HOME_DIRECTORY = ".shuv2code-v2";
export const PRODUCT_ID = "s2code";
export const LEGACY_PRODUCT_ID = "shuv2code";
// npm rejects the bare `s2code` name as too similar to existing packages.
export const NPM_PACKAGE_NAME = "@s2code/cli";
export const PRODUCT_HOME_MARKER = ".product-identity";
export const PRODUCT_CLI_SHIM_MARKER = `Written by ${PRODUCT_ID}: runs the desktop app's bundled CLI.`;
export const LEGACY_PRODUCT_CLI_SHIM_MARKER = `Written by ${LEGACY_PRODUCT_ID}: runs the desktop app's bundled CLI.`;
export const isOwnedCliShim = (content: string) =>
  content.includes(PRODUCT_CLI_SHIM_MARKER) || content.includes(LEGACY_PRODUCT_CLI_SHIM_MARKER);
// Keep installed updaters on the published repository until the external cutover.
export const PRODUCT_RELEASE_REPOSITORY = "shuv1337/s2code";
const PRODUCT_RELEASES_URL = `https://github.com/${PRODUCT_RELEASE_REPOSITORY}/releases`;

export const isProductIdentity = (value: string) =>
  value.trim() === PRODUCT_ID || value.trim() === LEGACY_PRODUCT_ID;

/** No fork mobile distribution exists yet; never substitute an upstream store listing. */
export const resolveProductDownload = (mobile: boolean) =>
  mobile
    ? { url: null, label: "Fork mobile apps are not available yet." }
    : { url: PRODUCT_RELEASES_URL, label: "Fork releases" };

/** Public settings are fork-owned; T3CODE names below remain runtime adapter inputs. */
const PUBLIC_CONFIG_KEYS = [
  "HOME",
  "PORT",
  "HOST",
  "MODE",
  "NO_BROWSER",
  "AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "CHANNEL",
  "VERSION",
  "INSTALL_BIN_DIR",
  "RELEASE_BASE_URL",
  "DESKTOP_UPDATE_REPOSITORY",
  "DESKTOP_LAN_HOST",
  "DESKTOP_HTTPS_ENDPOINTS",
  "DISABLE_AUTO_UPDATE",
  "HOSTED_APP_URL",
  "RELAY_URL",
  "MARKETING_URL",
  "SERVER_BROWSER_SANDBOX",
  "CLOUDFLARED_PATH",
  "LOG_LEVEL",
  "LOG_WS_EVENTS",
  "TRACE_FILE",
  "TRACE_MAX_FILES",
  "TRACE_MAX_BYTES",
  "TRACE_MIN_LEVEL",
  "TRACE_TIMING_ENABLED",
  "TRACE_BATCH_WINDOW_MS",
  "OTLP_TRACES_URL",
  "OTLP_METRICS_URL",
  "OTLP_LOGS_URL",
  "OTLP_EXPORT_INTERVAL_MS",
  "OTLP_HEADERS",
  "OTLP_PROTOCOL",
  "OTEL_SDK_DISABLED",
  "TAILSCALE_SERVE",
  "TAILSCALE_SERVE_PORT",
  "TELEMETRY_ENABLED",
  "TELEMETRY_FLUSH_BATCH_SIZE",
  "TELEMETRY_MAX_BUFFERED_EVENTS",
  "POSTHOG_HOST",
  "POSTHOG_KEY",
  "BITBUCKET_ACCESS_TOKEN",
  "BITBUCKET_API_BASE_URL",
  "BITBUCKET_API_TOKEN",
  "BITBUCKET_EMAIL",
  "CONTEXT_HANDOFF_TOKEN_CAP",
  "CODEX_LAUNCH_ARGS",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_CLI_OAUTH_CLIENT_ID",
  "CLERK_JWT_TEMPLATE",
  "CLERK_PASSKEY_RP_DOMAINS",
  "DESKTOP_APP_USER_MODEL_ID",
  "DESKTOP_WSL_RUNTIME",
  "IOS_BUNDLE_IDENTIFIER",
  "IOS_TEAM_ID",
  "IOS_PERSONAL_TEAM",
  "IOS_PERSONAL_TEAM_BUNDLE_ID",
  "MOBILE_VERSION",
  "MOBILE_ENV_NAME",
] as const;

const publicNames = new Set(
  PUBLIC_CONFIG_KEYS.flatMap((key) => [`S2CODE_${key}`, `SHUV2CODE_${key}`, `T3CODE_${key}`]),
);
const readEnvironmentValue = (env: Readonly<Record<string, string | undefined>>, name: string) =>
  env[name] ?? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
const readProductValue = (env: Readonly<Record<string, string | undefined>>, key: string) =>
  readEnvironmentValue(env, `S2CODE_${key}`)?.trim() ||
  readEnvironmentValue(env, `SHUV2CODE_${key}`)?.trim();

/** Resolve once at a process boundary, before any internal configuration is read. */
export function resolveProductEnvironment(env: Readonly<Record<string, string | undefined>>) {
  if (
    readEnvironmentValue(env, "S2CODE_IMPORT_UPSTREAM")?.trim() ||
    readEnvironmentValue(env, "SHUV2CODE_IMPORT_UPSTREAM")?.trim()
  ) {
    throw new Error(
      "Upstream import is not supported. Use a separate S2CODE_HOME; never point s2code at a live upstream home.",
    );
  }
  const resolved = { ...env };
  // Windows environment names are case-insensitive, even if a copied record is not.
  for (const name of Object.keys(resolved)) {
    if (publicNames.has(name.toUpperCase())) delete resolved[name];
  }
  for (const key of PUBLIC_CONFIG_KEYS) {
    const internal = `T3CODE_${key}`;
    const value = readProductValue(env, key);
    if (value) {
      resolved[`S2CODE_${key}`] = value;
      // Retained launchers and child runtimes must see the same selected setting.
      resolved[`SHUV2CODE_${key}`] = value;
      resolved[internal] = value;
    }
  }
  return resolved;
}

export function applyProductEnvironment(env: Record<string, string | undefined>) {
  if (
    readEnvironmentValue(env, "T3CODE_HOME")?.trim() &&
    readEnvironmentValue(env, "T3CODE_HOME")?.trim() !== readProductValue(env, "HOME")
  ) {
    // @effect-diagnostics-next-line globalConsole:off - Runs before the Effect/logger runtime is initialized.
    console.error("s2code: ignoring T3CODE_HOME; use S2CODE_HOME to configure the fork's home.");
  }
  const resolved = resolveProductEnvironment(env);
  for (const name of Object.keys(env)) {
    if (publicNames.has(name.toUpperCase())) delete env[name];
  }
  Object.assign(env, resolved);
}

/** The managed dev runner explicitly supports its old inputs, but fork overrides win. */
export function applyDevelopmentProductOverrides(env: Record<string, string | undefined>) {
  const resolved = resolveProductEnvironment(env);
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (
      readEnvironmentValue(env, `S2CODE_${key}`) === undefined &&
      readEnvironmentValue(env, `SHUV2CODE_${key}`) === undefined
    )
      continue;
    const internal = `T3CODE_${key}`;
    const value = resolved[internal];
    const selectedNames = new Set([`S2CODE_${key}`, `SHUV2CODE_${key}`, internal]);
    for (const name of Object.keys(env)) {
      if (selectedNames.has(name.toUpperCase())) delete env[name];
    }
    for (const name of [`S2CODE_${key}`, `SHUV2CODE_${key}`, internal]) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  }
}

export const PRODUCT_RUNTIME_MARKER = ".install-product";
export const runtimeCompletionMarker = (version: string) => `${version}\n`;
export const isProductRuntimeVersion = (version: string) =>
  /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version);

/** Keep completion compatible with retained launchers; ownership is independent. */
export function isProductRuntimeComplete(marker: string, version: string, product: string) {
  return isProductIdentity(product) && marker.trim() === version;
}
export const PRODUCT_DBUS_PREFIX = "io.github.shuv1337.s2code";
export const KDE_CAPTURE_HELPER_EXECUTABLE = `${PRODUCT_ID}-kde-snap-shot`;
