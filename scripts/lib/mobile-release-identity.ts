/** Shared by Expo config, release preflight and the dependency-free APK mirror. */
// Expo and native identifiers remain registered to existing installations so
// renaming the product cannot create a second app or lose credentials and OTA history.
export const MOBILE_SLUG = "shuv2code";
export const MOBILE_VARIANTS = {
  development: {
    appName: "S2Code Dev",
    displayName: "S2Code Dev",
    scheme: "s2code-dev",
    legacyScheme: "shuv2code-dev",
    iosBundleIdentifier: "dev.shuv.shuv2code.dev",
    androidPackage: "dev.shuv.shuv2code.dev",
  },
  preview: {
    appName: "S2Code Nightly",
    displayName: "S2Code Nightly",
    scheme: "s2code-nightly",
    legacyScheme: "shuv2code-nightly",
    iosBundleIdentifier: "dev.shuv.shuv2code.nightly",
    androidPackage: "dev.shuv.shuv2code.nightly",
  },
  production: {
    appName: "S2Code",
    displayName: "S2Code",
    scheme: "s2code",
    legacyScheme: "shuv2code",
    iosBundleIdentifier: "dev.shuv.shuv2code",
    androidPackage: "dev.shuv.shuv2code",
  },
} as const;
type Environment = Readonly<Record<string, string | undefined>>;
export class MobileReleaseConfigurationError extends Error {}
export const requiredMobileSetting = (env: Environment, key: string) => {
  const value = env[key]?.trim();
  if (!value)
    throw new MobileReleaseConfigurationError(
      `${key} is required for this mobile release operation.`,
    );
  return value;
};
export function resolveExpoIdentity(env: Environment) {
  const owner = env.EXPO_OWNER?.trim();
  const projectId = env.EXPO_PROJECT_ID?.trim();
  if (
    owner &&
    (!/^[\w-]+$/.test(owner) || ["pingdotgg", "t3tools", "t3code"].includes(owner.toLowerCase()))
  )
    throw new MobileReleaseConfigurationError(
      "EXPO_OWNER must identify the fork's Expo account, not upstream.",
    );
  if (
    projectId &&
    (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(projectId) ||
      projectId.toLowerCase() === "d763fcb8-d37c-41ea-a773-b54a0ab4a454")
  )
    throw new MobileReleaseConfigurationError(
      "EXPO_PROJECT_ID must identify the fork's Expo project, not upstream.",
    );
  if (projectId && !owner)
    throw new MobileReleaseConfigurationError(
      "EXPO_OWNER is required when EXPO_PROJECT_ID is configured.",
    );
  return { owner, projectId };
}
export function mobileReleaseConfiguration(
  env: Environment,
  options: { mode: string; profile: string; platform: string },
) {
  if (!["build", "update", "preview"].includes(options.mode))
    throw new Error("Unsupported mobile release mode.");
  if (!["production", "v2-preview", "preview:dev"].includes(options.profile))
    throw new Error("Unsupported mobile release profile.");
  if (!["all", "ios", "android"].includes(options.platform))
    throw new Error("Unsupported mobile platform.");
  if ((options.mode === "preview") !== (options.profile === "preview:dev"))
    throw new Error("Preview and store profiles must not be mixed.");
  if (options.mode === "update" && options.profile !== "production")
    throw new Error("V2 previews cannot publish OTA updates.");
  requiredMobileSetting(env, "EXPO_TOKEN");
  requiredMobileSetting(env, "EXPO_OWNER");
  requiredMobileSetting(env, "EXPO_PROJECT_ID");
  const expo = resolveExpoIdentity(env);
  if (options.mode === "update" && env.MOBILE_UPDATES_ENABLED !== "1")
    throw new Error("MOBILE_UPDATES_ENABLED=1 is required for an explicit OTA release.");
  const variant = options.mode === "preview" ? "preview" : "production";
  return {
    ...options,
    expo: { owner: expo.owner!, projectId: expo.projectId!, slug: MOBILE_SLUG },
    variant,
    identity: MOBILE_VARIANTS[variant],
  };
}
type ReleaseConfiguration = ReturnType<typeof mobileReleaseConfiguration>;
export function assertExpoDestination(config: ReleaseConfiguration, response: unknown) {
  const project = (
    response as {
      data?: { app?: { byId?: { id?: string; fullName?: string } } };
      errors?: unknown[];
    }
  )?.data?.app?.byId;
  if (
    (response as { errors?: unknown[] })?.errors?.length ||
    project?.id !== config.expo.projectId ||
    project.fullName !== `@${config.expo.owner}/${config.expo.slug}`
  )
    throw new MobileReleaseConfigurationError(
      "Expo project identity does not match the configured fork owner/project/slug.",
    );
}
export function assertAscDestination(appId: string, response: unknown) {
  const app = (response as { data?: { id?: string; attributes?: { bundleId?: string } } })?.data;
  if (
    appId === "6787819824" ||
    app?.id !== appId ||
    app.attributes?.bundleId !== MOBILE_VARIANTS.production.iosBundleIdentifier
  )
    throw new MobileReleaseConfigurationError(
      "App Store Connect destination does not match the fork production bundle ID.",
    );
}
export function assertGoogleAccount(value: unknown, expectedProjectId: string) {
  const account = value as {
    type?: string;
    project_id?: string;
    client_email?: string;
    private_key?: string;
    token_uri?: string;
  };
  if (
    account?.type !== "service_account" ||
    account.project_id !== expectedProjectId ||
    !account.client_email?.endsWith(`@${expectedProjectId}.iam.gserviceaccount.com`) ||
    !account.private_key ||
    account.token_uri !== "https://oauth2.googleapis.com/token"
  )
    throw new Error(
      "Google service account does not match the explicitly configured fork project.",
    );
  return account as {
    type: string;
    project_id: string;
    client_email: string;
    private_key: string;
    token_uri: string;
  };
}
export function assertFirebaseDestination(value: unknown, packageName: string, projectId: string) {
  const firebase = value as {
    project_info?: { project_id?: string };
    client?: { client_info?: { android_client_info?: { package_name?: string } } }[];
  };
  if (
    firebase?.project_info?.project_id !== projectId ||
    !firebase.client?.some(
      (client) => client.client_info?.android_client_info?.package_name === packageName,
    )
  )
    throw new Error(
      "Android Google services configuration does not match the fork package/Firebase project.",
    );
}
// t3.codes is the upstream hosted product; the other roots appear in upstream
// company metadata/security contacts. Match DNS boundaries, not substrings.
const UPSTREAM_MOBILE_HOSTS = [
  "t3.codes",
  "t3tools.com",
  "ping.gg",
  "pingdotgg.github.io",
  "t3tools.github.io",
];
function assertForkMobileHost(hostname: string, setting: string) {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (UPSTREAM_MOBILE_HOSTS.some((root) => host === root || host.endsWith(`.${root}`)))
    throw new MobileReleaseConfigurationError(
      `${setting} must not target an upstream hosted domain.`,
    );
}
/** Runs in Expo config too, even without release intent or account credentials. */
export function assertMobileHostedDestinations(env: Environment) {
  const authEnabled = env.MOBILE_AUTH_ENABLED === "1";
  if (authEnabled && env.MOBILE_AUTH_DOMAIN?.trim())
    assertForkMobileHost(env.MOBILE_AUTH_DOMAIN.trim(), "MOBILE_AUTH_DOMAIN");
  if (env.MOBILE_RELAY_URL?.trim())
    assertForkMobileHost(new URL(env.MOBILE_RELAY_URL.trim()).hostname, "MOBILE_RELAY_URL");
}
export function mobileAuthDomains(env: Environment) {
  if (env.MOBILE_AUTH_ENABLED !== "1") return [];
  const domain = env.MOBILE_AUTH_DOMAIN?.trim();
  if (!domain) return [];
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain))
    throw new Error("MOBILE_AUTH_DOMAIN must be a hostname.");
  assertForkMobileHost(domain, "MOBILE_AUTH_DOMAIN");
  return [`applinks:${domain}`, `webcredentials:${domain}`];
}
export function assertEnabledMobileFeatures(env: Environment, platform: string) {
  assertMobileHostedDestinations(env);
  if (env.MOBILE_AUTH_ENABLED === "1") {
    const domain = requiredMobileSetting(env, "MOBILE_AUTH_DOMAIN");
    mobileAuthDomains(env);
    const key = requiredMobileSetting(env, "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
    const encoded = /^pk_(?:test|live)_(.+)$/.exec(key)?.[1];
    if (!encoded || atob(encoded).replace(/\$$/, "") !== domain)
      throw new Error("Clerk publishable key does not match MOBILE_AUTH_DOMAIN.");
    requiredMobileSetting(env, "EXPO_PUBLIC_CLERK_JWT_TEMPLATE");
    const relay = new URL(requiredMobileSetting(env, "MOBILE_RELAY_URL"));
    if (relay.protocol !== "https:")
      throw new Error("MOBILE_RELAY_URL must use HTTPS for hosted release features.");
  }
  if (env.MOBILE_PUSH_ENABLED === "1") {
    if (platform !== "android") {
      if (
        requiredMobileSetting(env, "APNS_TEAM_ID") !== requiredMobileSetting(env, "APPLE_TEAM_ID")
      )
        throw new Error("APNs and iOS signing must use the same configured fork Apple team.");
      requiredMobileSetting(env, "APNS_KEY_ID");
    }
    if (platform !== "ios") requiredMobileSetting(env, "FIREBASE_PROJECT_ID");
  }
}
export function assertMobileBuildConfig(config: ReleaseConfiguration, value: unknown) {
  const app = value as {
    slug?: string;
    owner?: string;
    ios?: { bundleIdentifier?: string; appleTeamId?: string; associatedDomains?: string[] };
    android?: { package?: string };
    extra?: { eas?: { projectId?: string } };
    runtimeVersion?: { policy?: string };
    updates?: { enabled?: boolean; url?: string };
  };
  if (
    app.slug !== MOBILE_SLUG ||
    app.owner !== config.expo.owner ||
    app.extra?.eas?.projectId !== config.expo.projectId ||
    app.ios?.bundleIdentifier !== config.identity.iosBundleIdentifier ||
    app.android?.package !== config.identity.androidPackage
  )
    throw new Error("Resolved Expo configuration is not the selected fork installation.");
  if (app.runtimeVersion?.policy !== "fingerprint")
    throw new Error("Mobile release/OTA runtimeVersion must use the fingerprint policy.");
  if (app.updates?.url !== `https://u.expo.dev/${config.expo.projectId}`)
    throw new Error("OTA URL must be scoped to the verified fork project.");
  if (config.mode === "update" && app.updates.enabled !== true)
    throw new Error("OTA is not enabled in the resolved fork configuration.");
  if (config.profile === "v2-preview" && app.updates.enabled)
    throw new Error("V2 previews must keep OTA disabled.");
}
export function mobileTrack(env: Environment, profile: string) {
  const track = requiredMobileSetting(
    env,
    profile === "v2-preview" ? "GOOGLE_PLAY_PREVIEW_TRACK" : "GOOGLE_PLAY_TRACK",
  );
  if (!/^[a-z0-9_-]+$/i.test(track)) throw new Error("Configured Google Play track is invalid.");
  return track;
}
export function mirrorConfiguration(env: Environment) {
  if (requiredMobileSetting(env, "PACKAGE_NAME") !== MOBILE_VARIANTS.production.androidPackage)
    throw new Error("APK mirror must query the fork production package.");
  if (requiredMobileSetting(env, "GH_REPO") !== "shuv1337/shuv2code")
    throw new Error("APK mirror may publish only to the fork repository.");
  const track = requiredMobileSetting(env, "PLAY_TRACK");
  if (!/^[a-z0-9_-]+$/i.test(track)) throw new Error("Configured Play mirror track is invalid.");
  const certificate = requiredMobileSetting(env, "GOOGLE_PLAY_SIGNING_CERT_SHA256")
    .replaceAll(":", "")
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(certificate))
    throw new Error(
      "GOOGLE_PLAY_SIGNING_CERT_SHA256 must be the fork Play app-signing certificate digest.",
    );
  assertGoogleAccount(
    JSON.parse(requiredMobileSetting(env, "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")),
    requiredMobileSetting(env, "GOOGLE_PLAY_PROJECT_ID"),
  );
  return { packageName: MOBILE_VARIANTS.production.androidPackage, track, certificate };
}
export function assertApkIdentity(
  packageName: string,
  signatureOutput: string,
  expected: { packageName: string; certificate: string },
) {
  const certificates = [
    ...signatureOutput.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([a-f0-9:]+)\s*$/gim),
  ].map((match) => match[1]!.replaceAll(":", "").toLowerCase());
  if (
    packageName.trim() !== expected.packageName ||
    certificates.length !== 1 ||
    certificates[0] !== expected.certificate
  )
    throw new Error(
      "Downloaded APK package or signing certificate does not match the fork. Nothing will be attached.",
    );
}
