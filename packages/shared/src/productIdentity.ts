/** Fork-owned install identity; upstream protocol names intentionally stay stable. */
// Never open the old fork's divergent V1 migration ledger by default.
export const DEFAULT_HOME_DIRECTORY = ".shuv2code-v2";
export const PRODUCT_ID = "shuv2code";
export const PRODUCT_HOME_MARKER = ".product-identity";

/** Public settings are fork-owned; T3CODE names below remain runtime adapter inputs. */
export const PUBLIC_CONFIG_KEYS = [
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
] as const;

const publicInternalNames = new Set(PUBLIC_CONFIG_KEYS.map((key) => `T3CODE_${key}`));
const publicForkNames = new Set(PUBLIC_CONFIG_KEYS.map((key) => `SHUV2CODE_${key}`));
const readEnvironmentValue = (env: Readonly<Record<string, string | undefined>>, name: string) =>
  env[name] ?? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

/** Resolve once at a process boundary, before any internal configuration is read. */
export function resolveProductEnvironment(env: Readonly<Record<string, string | undefined>>) {
  if (readEnvironmentValue(env, "SHUV2CODE_IMPORT_UPSTREAM")?.trim()) {
    throw new Error(
      "Upstream import is not supported. Use a separate SHUV2CODE_HOME; never point shuv2code at a live upstream home.",
    );
  }
  const resolved = { ...env };
  // Windows environment names are case-insensitive, even if a copied record is not.
  for (const name of Object.keys(resolved)) {
    if (publicInternalNames.has(name.toUpperCase()) || publicForkNames.has(name.toUpperCase()))
      delete resolved[name];
  }
  for (const key of PUBLIC_CONFIG_KEYS) {
    const internal = `T3CODE_${key}`;
    // Updates replace the child, not its fork launcher. Keep that launcher's
    // transaction home; an upstream launcher never launches a fork executable.
    const value =
      readEnvironmentValue(env, `SHUV2CODE_${key}`)?.trim() ||
      (key === "HOME" && readEnvironmentValue(env, "T3_SERVICE_LAUNCHER_CONTEXT")?.trim()
        ? readEnvironmentValue(env, "T3CODE_HOME")?.trim()
        : undefined);
    if (value) {
      resolved[`SHUV2CODE_${key}`] = value;
      resolved[internal] = value;
    }
  }
  return resolved;
}

export function applyProductEnvironment(env: Record<string, string | undefined>) {
  if (
    readEnvironmentValue(env, "T3CODE_HOME")?.trim() &&
    !readEnvironmentValue(env, "SHUV2CODE_HOME")?.trim() &&
    !readEnvironmentValue(env, "T3_SERVICE_LAUNCHER_CONTEXT")?.trim()
  ) {
    // @effect-diagnostics-next-line globalConsole:off - Runs before the Effect/logger runtime is initialized.
    console.error(
      "shuv2code: ignoring T3CODE_HOME; use SHUV2CODE_HOME to configure the fork's home.",
    );
  }
  const resolved = resolveProductEnvironment(env);
  for (const name of Object.keys(env)) {
    if (publicInternalNames.has(name.toUpperCase()) || publicForkNames.has(name.toUpperCase()))
      delete env[name];
  }
  Object.assign(env, resolved);
}

/** The managed dev runner explicitly supports its old inputs, but fork overrides win. */
export function applyDevelopmentProductOverrides(env: Record<string, string | undefined>) {
  const resolved = resolveProductEnvironment(env);
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (readEnvironmentValue(env, `SHUV2CODE_${key}`) === undefined) continue;
    const internal = `T3CODE_${key}`;
    const value = resolved[internal];
    if (value === undefined) delete env[internal];
    else env[internal] = value;
  }
}

export const PRODUCT_RUNTIME_MARKER = ".install-product";
export const runtimeCompletionMarker = (version: string) => `${version}\n`;
export const isProductRuntimeVersion = (version: string) =>
  /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version);

/** Keep completion compatible with retained launchers; ownership is independent. */
export function isProductRuntimeComplete(marker: string, version: string, product: string) {
  return product.trim() === PRODUCT_ID && marker.trim() === version;
}
