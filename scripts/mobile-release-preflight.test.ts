// @effect-diagnostics nodeBuiltinImport:off -- Offline release CLI fixtures exercise native signing and file cleanup.
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { materializeMobileFirebaseConfig } from "./lib/mobile-firebase-config.ts";
import {
  MOBILE_VARIANTS,
  mobileReleaseConfiguration,
  resolveExpoIdentity,
  assertExpoDestination,
  assertAscDestination,
  assertMobileBuildConfig,
  assertFirebaseDestination,
  assertEnabledMobileFeatures,
  assertMobileHostedDestinations,
  mobileAuthDomains,
  mirrorConfiguration,
  assertApkIdentity,
} from "./lib/mobile-release-identity.ts";
import {
  mergeMobileEnvironment,
  prepareSubmissionConfig,
  verifyExpoProject,
  verifyStoreDestinations,
} from "./mobile-release-preflight.ts";

const env = {
  EXPO_TOKEN: "fixture",
  EXPO_OWNER: "fork-owner",
  EXPO_PROJECT_ID: "11111111-2222-3333-4444-555555555555",
  APPLE_TEAM_ID: "FORK123456",
};
const options = { mode: "build", profile: "production", platform: "all" };
const configuration = () => mobileReleaseConfiguration(env, options);
const project = {
  data: { app: { byId: { id: env.EXPO_PROJECT_ID, fullName: "@fork-owner/shuv2code" } } },
};
const resolvedApp = () => ({
  slug: "shuv2code",
  owner: env.EXPO_OWNER,
  ios: { bundleIdentifier: MOBILE_VARIANTS.production.iosBundleIdentifier },
  android: { package: MOBILE_VARIANTS.production.androidPackage },
  extra: { eas: { projectId: env.EXPO_PROJECT_ID } },
  runtimeVersion: { policy: "fingerprint" },
  updates: { enabled: false, url: `https://u.expo.dev/${env.EXPO_PROJECT_ID}` },
});
const googleAccount = {
  type: "service_account",
  project_id: "fork-project",
  client_email: "release@fork-project.iam.gserviceaccount.com",
  private_key: "fixture",
  token_uri: "https://oauth2.googleapis.com/token",
};
const mirrorEnv = {
  PACKAGE_NAME: MOBILE_VARIANTS.production.androidPackage,
  GH_REPO: "shuv1337/shuv2code",
  PLAY_TRACK: "fork-nightly",
  GOOGLE_PLAY_SIGNING_CERT_SHA256: "ab".repeat(32),
  GOOGLE_PLAY_PROJECT_ID: "fork-project",
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(googleAccount),
};

describe("fork mobile release preflight", () => {
  it("embeds and materializes the exact verified Firebase JSON instead of a divergent worker file", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-firebase-config-"));
    const json = JSON.stringify({
      project_info: { project_id: "fork-project" },
      client: [
        {
          client_info: {
            android_client_info: { package_name: MOBILE_VARIANTS.production.androidPackage },
          },
        },
      ],
    });
    const settings = {
      ...env,
      MOBILE_PUSH_ENABLED: "1",
      FIREBASE_PROJECT_ID: "fork-project",
      ANDROID_GOOGLE_SERVICES_JSON: json,
    };
    try {
      const prepared = prepareSubmissionConfig(
        { build: { production: {} }, submit: {} },
        settings,
        configuration(),
        {},
        directory,
      );
      expect(prepared.build.production?.env?.ANDROID_GOOGLE_SERVICES_JSON).toBe(json);
      const divergent = NodePath.join(directory, "worker-file.json");
      NodeFS.writeFileSync(divergent, "upstream worker config");
      const file = materializeMobileFirebaseConfig(
        { ...prepared.build.production?.env, ANDROID_GOOGLE_SERVICES_FILE: divergent },
        MOBILE_VARIANTS.production.androidPackage,
        directory,
      );
      expect(NodeFS.readFileSync(file, "utf8")).toBe(json);
      expect(NodeFS.readFileSync(divergent, "utf8")).toBe("upstream worker config");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
  it("forces preview OTA off after a production environment pull", () => {
    expect(
      mergeMobileEnvironment(
        { MOBILE_UPDATES_ENABLED: "0" },
        { MOBILE_UPDATES_ENABLED: "1" },
        "v2-preview",
      ).MOBILE_UPDATES_ENABLED,
    ).toBe("0");
  });
  it.each([
    "t3.codes",
    "clerk.t3.codes",
    "auth.t3tools.com",
    "auth.ping.gg",
    "pingdotgg.github.io",
    "t3tools.github.io",
  ])("rejects enabled auth for upstream host %s even with its matching key", (host) => {
    const auth = {
      MOBILE_AUTH_ENABLED: "1",
      MOBILE_AUTH_DOMAIN: host,
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa(`${host}$`)}`,
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "fixture",
      MOBILE_RELAY_URL: "https://relay.fork.example",
    };
    expect(() => assertEnabledMobileFeatures(auth, "all")).toThrow("upstream");
    expect(() => mobileAuthDomains(auth)).toThrow("upstream");
  });
  it.each([
    "https://relay.t3.codes",
    "https://RELAY.T3.CODES./v1",
    "https://relay.t3tools.com",
    "https://relay.ping.gg",
    "https://pingdotgg.github.io",
  ])("rejects upstream relay %s for enabled hosted features", (url) => {
    expect(() =>
      assertMobileHostedDestinations({
        MOBILE_AUTH_ENABLED: "0",
        MOBILE_PUSH_ENABLED: "0",
        MOBILE_RELAY_URL: url,
      }),
    ).toThrow("upstream");
    for (const flag of ["MOBILE_AUTH_ENABLED", "MOBILE_PUSH_ENABLED"])
      expect(() => assertMobileHostedDestinations({ [flag]: "1", MOBILE_RELAY_URL: url })).toThrow(
        "upstream",
      );
  });
  it("does not confuse fork host suffixes with upstream ownership", () => {
    expect(() =>
      assertMobileHostedDestinations({
        MOBILE_AUTH_ENABLED: "1",
        MOBILE_AUTH_DOMAIN: "auth.t3.codes.fork.example",
        MOBILE_RELAY_URL: "https://not-t3.codes.fork.example",
      }),
    ).not.toThrow();
  });
  it.each([
    { MOBILE_AUTH_DOMAIN: "clerk.t3.codes", MOBILE_RELAY_URL: "https://relay.fork.example" },
    { MOBILE_AUTH_DOMAIN: "auth.fork.example", MOBILE_RELAY_URL: "https://relay.t3.codes" },
  ])(
    "rejects upstream enabled hosted destinations during non-release Expo config evaluation (%j)",
    (settings) => {
      const cwd = NodeURL.fileURLToPath(new URL("../apps/mobile", import.meta.url));
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import config from "./app.config.ts"; console.log(JSON.stringify(config));',
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            APP_VARIANT: "production",
            EXPO_OWNER: "",
            EXPO_PROJECT_ID: "",
            MOBILE_AUTH_ENABLED: "1",
            MOBILE_PUSH_ENABLED: "0",
            MOBILE_UPDATES_ENABLED: "0",
            MOBILE_RELEASE_INTENT: "0",
            EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa(`${settings.MOBILE_AUTH_DOMAIN}$`)}`,
            ...settings,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("upstream");
      expect(result.stdout).toBe("");
    },
  );
  it("evaluates account-free Expo config with derived fork extension identities and no upstream hosted defaults", () => {
    const cwd = NodeURL.fileURLToPath(new URL("../apps/mobile", import.meta.url));
    for (const variant of ["production", "preview", "development"] as const) {
      const output = NodeChildProcess.execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import config from "./app.config.ts"; console.log(JSON.stringify(config));',
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            APP_VARIANT: variant,
            EXPO_OWNER: "",
            EXPO_PROJECT_ID: "",
            MOBILE_AUTH_ENABLED: "0",
            MOBILE_PUSH_ENABLED: "0",
            MOBILE_UPDATES_ENABLED: "0",
            SHUV2CODE_IOS_BUNDLE_IDENTIFIER: "",
            SHUV2CODE_IOS_PERSONAL_TEAM: "0",
          },
        },
      );
      const app = JSON.parse(output);
      expect(app.name).toBe(MOBILE_VARIANTS[variant].appName);
      expect(app.extra.displayName).toBe(MOBILE_VARIANTS[variant].displayName);
      expect(app.ios.infoPlist.CFBundleDisplayName).toBe(MOBILE_VARIANTS[variant].displayName);
      expect(app.ios.bundleIdentifier).toBe(MOBILE_VARIANTS[variant].iosBundleIdentifier);
      expect(app.android.package).toBe(MOBILE_VARIANTS[variant].androidPackage);
      expect(app.ios.associatedDomains).toEqual([]);
      expect(app.extra.pushEnabled).toBe(false);
      expect(app.extra.clerk.publishableKey).toBeNull();
      expect(app.updates.enabled).toBe(false);
      expect(app.extra.eas).toBeUndefined();
      const serialized = JSON.stringify(app);
      expect(serialized).toContain(`group.${app.ios.bundleIdentifier}`);
      expect(serialized).toContain(`${app.ios.bundleIdentifier}.widgets`);
      expect(serialized).not.toContain("clerk.t3.codes");
      expect(serialized).not.toContain("app.t3.codes");
      expect(serialized).not.toContain("com.t3tools.t3code");
      expect(app.runtimeVersion.policy).toBe(
        variant === "development" ? "appVersion" : "fingerprint",
      );
    }
    const require = NodeModule.createRequire(import.meta.url);
    const fingerprint = require("../apps/mobile/fingerprint.config.js");
    expect(fingerprint.extraSources).toContainEqual({
      type: "contents",
      id: "appMajorVersion",
      contents: "2",
    });
  });
  it("leaves local/direct config independent of Expo accounts", () => {
    expect(resolveExpoIdentity({})).toEqual({ owner: undefined, projectId: undefined });
    expect(mobileAuthDomains({})).toEqual([]);
  });
  it.each(["EXPO_TOKEN", "EXPO_OWNER", "EXPO_PROJECT_ID"])(
    "fails clearly before remote work without %s",
    async (name) => {
      const missing = { ...env, [name]: "" };
      let requests = 0;
      await expect(
        verifyExpoProject(missing, options, async () => {
          requests++;
          return project;
        }),
      ).rejects.toThrow(name);
      expect(requests).toBe(0);
    },
  );
  it.each([
    { EXPO_OWNER: "pingdotgg" },
    { EXPO_OWNER: "T3tools" },
    { EXPO_PROJECT_ID: "d763fcb8-d37c-41ea-a773-b54a0ab4a454" },
    { EXPO_PROJECT_ID: "invalid" },
  ])("rejects upstream/invalid Expo settings %j", (override) => {
    expect(() => resolveExpoIdentity({ ...env, ...override })).toThrow();
  });
  it("checks remote project id, owner and slug before env pull", async () => {
    const calls: string[] = [];
    await verifyExpoProject(env, options, async (url, init) => {
      calls.push(url);
      expect(JSON.parse(String(init?.body)).variables.appId).toBe(env.EXPO_PROJECT_ID);
      return project;
    });
    expect(calls).toEqual(["https://api.expo.dev/graphql"]);
    for (const fullName of ["@pingdotgg/shuv2code", "@fork-owner/t3code"])
      expect(() =>
        assertExpoDestination(configuration(), {
          data: { app: { byId: { id: env.EXPO_PROJECT_ID, fullName } } },
        }),
      ).toThrow();
    expect(() => assertExpoDestination(configuration(), { errors: [{}], ...project })).toThrow();
  });
  it("verifies ASC application and fork bundle together", () => {
    expect(() =>
      assertAscDestination("123456", {
        data: {
          id: "123456",
          attributes: { bundleId: MOBILE_VARIANTS.production.iosBundleIdentifier },
        },
      }),
    ).not.toThrow();
    for (const bundleId of ["com.t3tools.t3code", MOBILE_VARIANTS.preview.iosBundleIdentifier])
      expect(() =>
        assertAscDestination("123456", { data: { id: "123456", attributes: { bundleId } } }),
      ).toThrow();
    expect(() =>
      assertAscDestination("6787819824", {
        data: {
          id: "6787819824",
          attributes: { bundleId: MOBILE_VARIANTS.production.iosBundleIdentifier },
        },
      }),
    ).toThrow();
  });
  it("resolves only the selected fork native identity and fingerprint runtime", () => {
    expect(() => assertMobileBuildConfig(configuration(), resolvedApp())).not.toThrow();
    expect(() =>
      assertMobileBuildConfig(configuration(), {
        ...resolvedApp(),
        android: { package: "com.t3tools.t3code" },
      }),
    ).toThrow();
    expect(() =>
      assertMobileBuildConfig(configuration(), {
        ...resolvedApp(),
        runtimeVersion: { policy: "appVersion" },
      }),
    ).toThrow();
    expect(() =>
      assertMobileBuildConfig(configuration(), {
        ...resolvedApp(),
        updates: { url: "https://u.expo.dev/upstream" },
      }),
    ).toThrow();
  });
  it("keeps OTA opt-in, rejects preview updates, requires resolved enabled state", () => {
    expect(() => mobileReleaseConfiguration(env, { ...options, mode: "update" })).toThrow(
      "MOBILE_UPDATES_ENABLED",
    );
    expect(() =>
      mobileReleaseConfiguration(
        { ...env, MOBILE_UPDATES_ENABLED: "1" },
        { ...options, mode: "update", profile: "v2-preview" },
      ),
    ).toThrow();
    const update = mobileReleaseConfiguration(
      { ...env, MOBILE_UPDATES_ENABLED: "1" },
      { ...options, mode: "update" },
    );
    expect(() => assertMobileBuildConfig(update, resolvedApp())).toThrow("not enabled");
    expect(() =>
      assertMobileBuildConfig(update, {
        ...resolvedApp(),
        updates: { ...resolvedApp().updates, enabled: true },
      }),
    ).not.toThrow();
  });
  it("cannot redirect identity or enabled features through eas env:pull", () => {
    expect(() => mergeMobileEnvironment(env, { EXPO_OWNER: "pingdotgg" })).toThrow("EXPO_OWNER");
    expect(() => mergeMobileEnvironment(env, { MOBILE_PUSH_ENABLED: "1" })).toThrow(
      "MOBILE_PUSH_ENABLED",
    );
    expect(
      mergeMobileEnvironment(env, { EXPO_PROJECT_ID: env.EXPO_PROJECT_ID, OPTIONAL: "fixture" })
        .OPTIONAL,
    ).toBe("fixture");
  });
  it("requires matching hosted auth and push identities only when enabled", () => {
    expect(() => assertEnabledMobileFeatures({}, "all")).not.toThrow();
    expect(() => assertEnabledMobileFeatures({ MOBILE_AUTH_ENABLED: "1" }, "all")).toThrow(
      "MOBILE_AUTH_DOMAIN",
    );
    const auth = {
      MOBILE_AUTH_ENABLED: "1",
      MOBILE_AUTH_DOMAIN: "auth.fork.example",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("auth.fork.example$")}`,
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "fork",
      MOBILE_RELAY_URL: "https://relay.fork.example",
    };
    expect(() => assertEnabledMobileFeatures(auth, "all")).not.toThrow();
    expect(() =>
      assertEnabledMobileFeatures({ ...auth, MOBILE_AUTH_DOMAIN: "other.example" }, "all"),
    ).toThrow("does not match");
    expect(mobileAuthDomains(auth)).toEqual([
      "applinks:auth.fork.example",
      "webcredentials:auth.fork.example",
    ]);
    expect(() =>
      assertEnabledMobileFeatures(
        {
          MOBILE_PUSH_ENABLED: "1",
          APPLE_TEAM_ID: "FORK123456",
          APNS_TEAM_ID: "OTHER12345",
          APNS_KEY_ID: "fixture",
        },
        "ios",
      ),
    ).toThrow("same configured fork");
  });
  it("checks Firebase project and actual Android client package", () => {
    const firebase = {
      project_info: { project_id: "fork" },
      client: [
        {
          client_info: {
            android_client_info: { package_name: MOBILE_VARIANTS.production.androidPackage },
          },
        },
      ],
    };
    expect(() =>
      assertFirebaseDestination(firebase, MOBILE_VARIANTS.production.androidPackage, "fork"),
    ).not.toThrow();
    expect(() =>
      assertFirebaseDestination(firebase, MOBILE_VARIANTS.preview.androidPackage, "fork"),
    ).toThrow();
    expect(() =>
      assertFirebaseDestination(firebase, MOBILE_VARIANTS.production.androidPackage, "upstream"),
    ).toThrow();
  });
  it("checks Play account project and exact configured package/track using remote API", async () => {
    const privateKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const settings = {
      ...env,
      GOOGLE_PLAY_PROJECT_ID: "fork-project",
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
        ...googleAccount,
        private_key: privateKey,
      }),
      GOOGLE_PLAY_TRACK: "fork-internal",
    };
    const android = mobileReleaseConfiguration(settings, { ...options, platform: "android" });
    const calls: string[] = [];
    expect(
      await verifyStoreDestinations(settings, android, async (url) => {
        calls.push(url);
        return url.endsWith("/token") ? { access_token: "fixture" } : { releases: [] };
      }),
    ).toEqual({ track: "fork-internal" });
    expect(calls[1]).toBe(
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/dev.shuv.shuv2code/tracks/fork-internal/releases",
    );
    await expect(
      verifyStoreDestinations(
        { ...settings, GOOGLE_PLAY_PROJECT_ID: "upstream" },
        android,
        async () => ({}),
      ),
    ).rejects.toThrow("configured fork project");
  });
  it("prepares explicit submission IDs/tracks/credentials without persisting private key contents", () => {
    const settings = {
      ...env,
      ASC_KEY_ID: "key",
      ASC_ISSUER_ID: "issuer",
      MOBILE_UPDATES_ENABLED: "1",
    };
    const eas = {
      build: { production: { env: {} }, "v2-preview": { env: {} } },
      submit: { production: { ios: {}, android: {} } },
    };
    const prepared = prepareSubmissionConfig(
      eas,
      settings,
      configuration(),
      { ascAppId: "123456", track: "fork-internal" },
      "/fixture/credentials",
    );
    expect(prepared.submit.production?.ios?.ascAppId).toBe("123456");
    expect(prepared.submit.production?.android?.serviceAccountKeyPath).toBe(
      "/fixture/credentials/play.json",
    );
    expect(eas.submit.production.ios).toEqual({});
    const preview = prepareSubmissionConfig(
      eas,
      settings,
      mobileReleaseConfiguration(env, { ...options, profile: "v2-preview" }),
      { track: "fork-nightly" },
      "/fixture/credentials",
    );
    expect(preview.build["v2-preview"]?.env?.MOBILE_UPDATES_ENABLED).toBe("0");
    expect(preview.submit["v2-preview"]?.android?.track).toBe("fork-nightly");
  });
});

describe("fork APK attachment gate", () => {
  it("uploads only after package and certificate verification both succeed", async () => {
    const require = NodeModule.createRequire(import.meta.url);
    const { uploadApk } = require("../.github/scripts/mirror-play-apk.cjs") as {
      uploadApk: (input: object, dependencies: object) => Promise<boolean>;
    };
    const calls: string[] = [];
    expect(
      await uploadApk(
        {
          token: "fixture",
          appUrl: "https://fixture",
          build: { versionCode: 1 },
          tag: "fixture",
          apkName: "fixture.apk",
          notes: "fixture",
          release: null,
          expected: mirrorConfiguration(mirrorEnv),
        },
        {
          play: async (_token: string, _method: string, url: string) =>
            url.includes("download")
              ? new Response("fixture-apk")
              : new Response(
                  JSON.stringify({
                    generatedApks: [{ generatedUniversalApk: { downloadId: "fixture" } }],
                  }),
                ),
          gh: (...args: string[]) => {
            calls.push(args.slice(0, 2).join(" "));
            return "";
          },
          execFileSync: (tool: string) => {
            calls.push(tool);
            return tool === "apkanalyzer"
              ? mirrorEnv.PACKAGE_NAME
              : `Signer #1 certificate SHA-256 digest: ${mirrorEnv.GOOGLE_PLAY_SIGNING_CERT_SHA256}`;
          },
        },
      ),
    ).toBe(true);
    expect(calls).toEqual(["apkanalyzer", "apksigner", "release create", "release upload"]);
  });
  it("fails closed on missing digest, upstream package and foreign mirror repository", () => {
    expect(mirrorConfiguration(mirrorEnv).certificate).toBe("ab".repeat(32));
    for (const override of [
      { GOOGLE_PLAY_SIGNING_CERT_SHA256: "" },
      { PACKAGE_NAME: "com.t3tools.t3code" },
      { GH_REPO: "pingdotgg/t3code" },
    ])
      expect(() => mirrorConfiguration({ ...mirrorEnv, ...override })).toThrow();
  });
  it("rejects wrong package, wrong signer, unsigned and multiple-signer APKs", () => {
    const expected = mirrorConfiguration(mirrorEnv);
    const signature = `Signer #1 certificate SHA-256 digest: ${expected.certificate}`;
    expect(() => assertApkIdentity(expected.packageName, signature, expected)).not.toThrow();
    expect(() => assertApkIdentity("com.t3tools.t3code", signature, expected)).toThrow();
    expect(() =>
      assertApkIdentity(expected.packageName, signature.replaceAll("ab", "cd"), expected),
    ).toThrow();
    expect(() => assertApkIdentity(expected.packageName, "", expected)).toThrow();
    expect(() =>
      assertApkIdentity(
        expected.packageName,
        `${signature}\n${signature.replace("#1", "#2")}`,
        expected,
      ),
    ).toThrow();
  });
  it.each(["package", "signature", "tool-failure"])(
    "never calls GitHub upload on %s mismatch and removes the downloaded file",
    async (failure) => {
      const require = NodeModule.createRequire(import.meta.url);
      const { uploadApk } = require("../.github/scripts/mirror-play-apk.cjs") as {
        uploadApk: (input: object, dependencies: object) => Promise<boolean>;
      };
      let artifactPath = "";
      const github: string[][] = [];
      await expect(
        uploadApk(
          {
            token: "fixture",
            appUrl: "https://fixture",
            build: { versionCode: 1 },
            tag: "fixture",
            apkName: "fixture.apk",
            notes: "fixture",
            release: null,
            expected: mirrorConfiguration(mirrorEnv),
          },
          {
            play: async (_token: string, _method: string, url: string) =>
              url.includes("download")
                ? new Response("fixture-apk")
                : new Response(
                    JSON.stringify({
                      generatedApks: [{ generatedUniversalApk: { downloadId: "fixture" } }],
                    }),
                  ),
            gh: (...args: string[]) => {
              github.push(args);
              return "";
            },
            execFileSync: (tool: string, args: string[]) => {
              artifactPath = args.at(-1)!;
              if (failure === "tool-failure") throw new Error("tool failed");
              return tool === "apkanalyzer"
                ? failure === "package"
                  ? "com.t3tools.t3code"
                  : mirrorEnv.PACKAGE_NAME
                : "Signer #1 certificate SHA-256 digest: " + "cd".repeat(32);
            },
          },
        ),
      ).rejects.toThrow();
      expect(github).toEqual([]);
      expect(artifactPath).not.toBe("");
      expect(NodeFS.existsSync(artifactPath)).toBe(false);
    },
  );
});
