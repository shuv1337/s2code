// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalConsole:off -- Release CLI boundary; never invoked by local/direct app startup.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import {
  mobileReleaseConfiguration,
  assertExpoDestination,
  assertAscDestination,
  assertGoogleAccount,
  assertMobileBuildConfig,
  assertEnabledMobileFeatures,
  requiredMobileSetting,
  mobileTrack,
  MobileReleaseConfigurationError,
} from "./lib/mobile-release-identity.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type RequestJson = (url: string, init?: RequestInit) => Promise<unknown>;
const requestJson: RequestJson = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(
      `Mobile destination verification failed (HTTP ${response.status}). Check account access and fork app/track registration.`,
    );
  return response.json();
};
export async function verifyExpoProject(
  env: Environment,
  options: { mode: string; profile: string; platform: string },
  request: RequestJson = requestJson,
) {
  const config = mobileReleaseConfiguration(env, options);
  // Same AppInfo query used by eas-cli project:info, without depending on its human-readable output.
  const response = await request("https://api.expo.dev/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requiredMobileSetting(env, "EXPO_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: "query AppInfo($appId: String!) { app { byId(appId: $appId) { id fullName } } }",
      variables: { appId: config.expo.projectId },
    }),
  });
  assertExpoDestination(config, response);
  return config;
}
function signedJwt(header: object, payload: object, key: string, algorithm: string, ec = false) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const message = `${encode(header)}.${encode(payload)}`;
  const signature = NodeCrypto.sign(
    algorithm,
    Buffer.from(message),
    ec ? { key, dsaEncoding: "ieee-p1363" } : key,
  );
  return `${message}.${signature.toString("base64url")}`;
}
export async function verifyStoreDestinations(
  env: Environment,
  config: ReturnType<typeof mobileReleaseConfiguration>,
  request: RequestJson = requestJson,
) {
  const ios = config.platform !== "android";
  const android = config.platform !== "ios";
  const now = Math.floor(Date.now() / 1000);
  assertEnabledMobileFeatures(env, config.platform);
  if (ios && !/^[A-Z0-9]{10}$/.test(requiredMobileSetting(env, "APPLE_TEAM_ID")))
    throw new Error("APPLE_TEAM_ID must be the fork's paid Apple Developer team ID.");
  if (config.mode !== "build") return {};
  const result: { ascAppId?: string; track?: string } = {};
  if (ios) {
    const appId = requiredMobileSetting(env, "ASC_APP_ID");
    if (!/^\d+$/.test(appId) || appId === "6787819824")
      throw new Error("ASC_APP_ID must be the fork App Store Connect application, not upstream.");
    const token = signedJwt(
      { alg: "ES256", kid: requiredMobileSetting(env, "ASC_KEY_ID"), typ: "JWT" },
      {
        iss: requiredMobileSetting(env, "ASC_ISSUER_ID"),
        iat: now,
        exp: now + 600,
        aud: "appstoreconnect-v1",
      },
      requiredMobileSetting(env, "ASC_API_PRIVATE_KEY"),
      "sha256",
      true,
    );
    assertAscDestination(
      appId,
      await request(
        `https://api.appstoreconnect.apple.com/v1/apps/${appId}?fields[apps]=bundleId`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    );
    result.ascAppId = appId;
  }
  if (android) {
    const account = assertGoogleAccount(
      JSON.parse(requiredMobileSetting(env, "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")),
      requiredMobileSetting(env, "GOOGLE_PLAY_PROJECT_ID"),
    );
    const assertion = signedJwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/androidpublisher",
        aud: account.token_uri,
        iat: now,
        exp: now + 600,
      },
      account.private_key,
      "RSA-SHA256",
    );
    const response = await request(account.token_uri, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const token = (response as { access_token?: unknown })?.access_token;
    if (typeof token !== "string" || !token)
      throw new Error("Google Play authorization did not return an access token.");
    const track = mobileTrack(env, config.profile);
    await request(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${config.identity.androidPackage}/tracks/${track}/releases`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    result.track = track;
  }
  return result;
}

/** Keep pulled variables from redirecting an already verified project or changing release opt-ins. */
export function mergeMobileEnvironment(
  env: Environment,
  pulled: Environment,
  profile = "production",
): Environment {
  for (const key of [
    "EXPO_OWNER",
    "EXPO_PROJECT_ID",
    "MOBILE_UPDATES_ENABLED",
    "MOBILE_AUTH_ENABLED",
    "MOBILE_PUSH_ENABLED",
    "APPLE_TEAM_ID",
    "FIREBASE_PROJECT_ID",
  ]) {
    if (key === "MOBILE_UPDATES_ENABLED" && profile === "v2-preview") continue;
    if (pulled[key] !== undefined && pulled[key] !== env[key])
      throw new Error(`Pulled EAS environment conflicts with protected setting ${key}.`);
  }
  return {
    ...pulled,
    ...env,
    ...(profile === "v2-preview" ? { MOBILE_UPDATES_ENABLED: "0" } : {}),
  };
}
export function prepareSubmissionConfig(
  eas: {
    build: Record<string, { env?: Record<string, string>; [key: string]: unknown }>;
    submit: Record<
      string,
      { ios?: Record<string, unknown>; android?: Record<string, unknown>; [key: string]: unknown }
    >;
  },
  env: Environment,
  config: ReturnType<typeof mobileReleaseConfiguration>,
  destinations: { ascAppId?: string; track?: string },
  credentialsDirectory: string,
) {
  const next = structuredClone(eas);
  const profile = next.build[config.profile];
  if (!profile) throw new Error("Build profile is missing.");
  profile.env = {
    ...profile.env,
    EXPO_OWNER: config.expo.owner,
    EXPO_PROJECT_ID: config.expo.projectId,
    MOBILE_RELEASE_INTENT: "1",
    MOBILE_RELEASE_PLATFORM: config.platform,
  };
  for (const key of [
    "APPLE_TEAM_ID",
    "MOBILE_UPDATES_ENABLED",
    "MOBILE_PUSH_ENABLED",
    "MOBILE_AUTH_ENABLED",
    "MOBILE_AUTH_DOMAIN",
    "MOBILE_RELAY_URL",
    "FIREBASE_PROJECT_ID",
    "APNS_TEAM_ID",
    "APNS_KEY_ID",
    "ANDROID_GOOGLE_SERVICES_JSON",
  ]) {
    if (env[key] !== undefined) profile.env[key] = env[key]!;
  }
  if (config.profile === "v2-preview") profile.env.MOBILE_UPDATES_ENABLED = "0";
  if (config.mode !== "build") return next;
  const submit = next.submit[config.profile] ?? {};
  if (destinations.ascAppId)
    submit.ios = {
      ...submit.ios,
      ascAppId: destinations.ascAppId,
      appleTeamId: requiredMobileSetting(env, "APPLE_TEAM_ID"),
      ascApiKeyId: requiredMobileSetting(env, "ASC_KEY_ID"),
      ascApiKeyIssuerId: requiredMobileSetting(env, "ASC_ISSUER_ID"),
      ascApiKeyPath: NodePath.join(credentialsDirectory, "asc.p8"),
    };
  if (destinations.track)
    submit.android = {
      ...submit.android,
      track: destinations.track,
      serviceAccountKeyPath: NodePath.join(credentialsDirectory, "play.json"),
    };
  next.submit[config.profile] = submit;
  return next;
}
async function main() {
  const { values, positionals } = NodeUtil.parseArgs({
    options: {
      mode: { type: "string", default: "build" },
      profile: { type: "string", default: "production" },
      platform: { type: "string", default: "all" },
    },
    allowPositionals: true,
  });
  const phase = positionals[0];
  if (phase !== "project" && phase !== "prepare")
    throw new Error(
      "Use project before eas env:pull, then prepare before build/submission/update.",
    );
  const options = { mode: values.mode!, profile: values.profile!, platform: values.platform! };
  const mobileDir = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../apps/mobile",
  );
  let env: Record<string, string | undefined> = { ...process.env };
  if (options.profile === "v2-preview") env.MOBILE_UPDATES_ENABLED = "0";
  if (phase === "prepare") {
    const file = NodePath.join(mobileDir, ".env.local");
    if (NodeFS.existsSync(file))
      env = mergeMobileEnvironment(
        env,
        NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")),
        options.profile,
      );
    env.MOBILE_RELEASE_INTENT = "1";
    env.MOBILE_RELEASE_PLATFORM = options.platform;
    // A file secret must be available to local fingerprint/config evaluation as well as EAS workers.
    if (
      env.MOBILE_PUSH_ENABLED === "1" &&
      options.platform !== "ios" &&
      (env.ANDROID_GOOGLE_SERVICES_JSON || env.ANDROID_GOOGLE_SERVICES_FILE)
    ) {
      // Freeze the same public Firebase app configuration into the build profile.
      // Workers materialize this verified JSON instead of using a different EAS file variable.
      env.ANDROID_GOOGLE_SERVICES_JSON ??= NodeFS.readFileSync(
        env.ANDROID_GOOGLE_SERVICES_FILE!,
        "utf8",
      );
    }
  }
  const config = await verifyExpoProject(env, options);
  if (phase === "project") {
    console.log("Verified fork Expo owner/project/slug before environment pull.");
    return;
  }
  const output = NodeChildProcess.execFileSync(
    "npx",
    ["expo", "config", "--json", "--type", "public"],
    { cwd: mobileDir, env, encoding: "utf8" },
  );
  const app = JSON.parse(output) as { ios?: { appleTeamId?: string } };
  assertMobileBuildConfig(config, app);
  if (options.platform !== "android" && app.ios?.appleTeamId !== env.APPLE_TEAM_ID)
    throw new Error("Resolved iOS signing team does not match APPLE_TEAM_ID.");
  const destinations = await verifyStoreDestinations(env, config);
  const credentialsDirectory = NodeFS.mkdtempSync(
    NodePath.join(env.RUNNER_TEMP ?? NodeOS.tmpdir(), "fork-mobile-submit-"),
  );
  if (destinations.ascAppId)
    NodeFS.writeFileSync(
      NodePath.join(credentialsDirectory, "asc.p8"),
      requiredMobileSetting(env, "ASC_API_PRIVATE_KEY"),
      { mode: 0o600 },
    );
  if (destinations.track)
    NodeFS.writeFileSync(
      NodePath.join(credentialsDirectory, "play.json"),
      requiredMobileSetting(env, "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"),
      { mode: 0o600 },
    );
  const easPath = NodePath.join(mobileDir, "eas.json");
  NodeFS.writeFileSync(
    easPath,
    `${JSON.stringify(prepareSubmissionConfig(JSON.parse(NodeFS.readFileSync(easPath, "utf8")), env, config, destinations, credentialsDirectory), null, 2)}\n`,
  );
  if (env.GITHUB_ENV) {
    // Only flags/identities, public Firebase app JSON and file paths, never private credentials.
    env.MOBILE_SUBMISSION_CREDENTIALS_DIR = credentialsDirectory;
    const keys = [
      "MOBILE_RELEASE_INTENT",
      "MOBILE_RELEASE_PLATFORM",
      "MOBILE_UPDATES_ENABLED",
      "ANDROID_GOOGLE_SERVICES_FILE",
      "ANDROID_GOOGLE_SERVICES_JSON",
      "MOBILE_SUBMISSION_CREDENTIALS_DIR",
      ...Object.keys(env).filter((key) => key.startsWith("EXPO_PUBLIC_")),
    ];
    const delimiter = `MOBILE_${NodeCrypto.randomBytes(16).toString("hex")}`;
    NodeFS.appendFileSync(
      env.GITHUB_ENV,
      keys
        .filter((key) => env[key] !== undefined)
        .map((key) => `${key}<<${delimiter}\n${env[key]}\n${delimiter}\n`)
        .join(""),
    );
  }
  console.log(
    "Verified fork mobile configuration and destination access; submission config prepared. This is not delivery verification.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      error instanceof MobileReleaseConfigurationError
        ? error.message
        : "Mobile release preflight failed. Check fork identities, account access and signing configuration; no build/submission was started.",
    );
    process.exitCode = 1;
  });
}
