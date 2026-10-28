import type { ExpoConfig } from "expo/config";
import { applyDevelopmentProductOverrides } from "@t3tools/shared/productIdentity";
import { forkHostedOrigin, forkClerkPublishableKey } from "@t3tools/shared/hostedConfig";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { materializeMobileFirebaseConfig } from "../../scripts/lib/mobile-firebase-config.ts";

import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import {
  MOBILE_SLUG,
  MOBILE_VARIANTS,
  resolveExpoIdentity,
  mobileAuthDomains,
  assertEnabledMobileFeatures,
  assertMobileHostedDestinations,
} from "../../scripts/lib/mobile-release-identity.ts";

type AppVariant = "development" | "preview" | "production";

const repoEnv = loadRepoEnv();
applyDevelopmentProductOverrides(repoEnv);
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);
const expoIdentity = resolveExpoIdentity(repoEnv);
const pushEnabled = repoEnv.MOBILE_PUSH_ENABLED === "1";
const authEnabled = repoEnv.MOBILE_AUTH_ENABLED === "1";
assertMobileHostedDestinations(repoEnv);
const releasePlatform = repoEnv.EAS_BUILD_PLATFORM ?? repoEnv.MOBILE_RELEASE_PLATFORM ?? "all";
if (repoEnv.MOBILE_RELEASE_INTENT === "1") assertEnabledMobileFeatures(repoEnv, releasePlatform);
if (repoEnv.MOBILE_UPDATES_ENABLED === "1" && !expoIdentity.projectId)
  throw new Error("EXPO_PROJECT_ID and EXPO_OWNER are required when opting into fork OTA updates.");
const isIosPersonalTeamBuild = repoEnv.T3CODE_IOS_PERSONAL_TEAM === "1";
const runtimeVersionPolicy =
  process.env.MOBILE_VERSION_POLICY ??
  (APP_VARIANT === "development" ? "appVersion" : "fingerprint");

// EAS assigns store build numbers remotely (eas.json appVersionSource), so a
// local build would otherwise always report build 1. Stamp local builds with
// the commit count so a device install shows which commit it came from.
const localBuildNumber = process.env.EAS_BUILD
  ? undefined
  : Number(
      NodeChildProcess.execFileSync("git", ["rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    );

const personalTeamBundleIdentifier = repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// Compiled into the native project. Without a relay, Observe's native side could dispatch to
// Expo's own ingest before observe.ts turns it off; `.invalid` never resolves (RFC 6761).
const observeEndpointUrl = repoEnv.T3CODE_RELAY_URL?.trim()
  ? new URL("/v1/mobile/observe", repoEnv.T3CODE_RELAY_URL.trim()).toString()
  : "https://observe.invalid";

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
const androidAdaptiveForeground = "./assets/android-icon-foreground.png";

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as com.example.t3code when T3CODE_IOS_PERSONAL_TEAM=1.",
  );
}

const DEVELOPMENT_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.developmentIosIconPng),
  androidAdaptiveForeground: "./assets/android-icon-foreground-dev.png",
  androidAdaptiveBackgroundColor: "#0C1119",
  androidAdaptiveBackgroundImage: "./assets/android-icon-background-dev.png",
  androidSplashIcon: "./assets/android-splash-icon-dev.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#00639B",
} as const;

const RELEASE_ASSETS = {
  appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  iosIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIconComposerProject),
  splashIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng),
  androidAdaptiveForeground,
  androidAdaptiveBackgroundColor: "#0C1119",
  androidAdaptiveBackgroundImage: undefined,
  androidSplashIcon: "./assets/android-splash-icon-prod.png",
  androidMonochromeIcon: "./assets/android-icon-mark.png",
  androidNotificationIcon: "./assets/android-notification-icon.png",
  androidNotificationColor: "#FFFFFF",
} as const;

const VARIANT_CONFIG = {
  development: {
    ...MOBILE_VARIANTS.development,
    assets: DEVELOPMENT_ASSETS,
  },
  preview: {
    ...MOBILE_VARIANTS.preview,
    assets: RELEASE_ASSETS,
  },
  production: {
    ...MOBILE_VARIANTS.production,
    assets: RELEASE_ASSETS,
  },
} as const;

function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
      return value;
    default:
      return "production";
  }
}

// A fork signing with its own paid team cannot use upstream's App IDs. These
// override just the identity; every derived ID (widgets, app group, watch)
// follows. Release preflight requires the registered fork production identity.
const forkBundleIdentifier = repoEnv.T3CODE_IOS_BUNDLE_IDENTIFIER?.trim();
if (forkBundleIdentifier && !IOS_BUNDLE_IDENTIFIER_PATTERN.test(forkBundleIdentifier)) {
  throw new Error(
    "T3CODE_IOS_BUNDLE_IDENTIFIER must be a reverse-DNS identifier such as com.example.t3code.",
  );
}
const appleTeamId = repoEnv.APPLE_TEAM_ID?.trim() ?? repoEnv.T3CODE_IOS_TEAM_ID?.trim();

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : forkBundleIdentifier
    ? forkBundleIdentifier +
      variant.iosBundleIdentifier.slice(VARIANT_CONFIG.production.iosBundleIdentifier.length)
    : variant.iosBundleIdentifier;
if (iosBundleIdentifier.startsWith("com.t3tools."))
  throw new Error("Upstream iOS bundle identifiers cannot be used for fork builds.");
const googleServicesFile =
  pushEnabled && releasePlatform !== "ios"
    ? materializeMobileFirebaseConfig(
        repoEnv,
        variant.androidPackage,
        NodeURL.fileURLToPath(new URL(".", import.meta.url)),
      )
    : undefined;

const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

const widgetsPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-widgets",
  {
    bundleIdentifier: `${iosBundleIdentifier}.widgets`,
    groupIdentifier: `group.${iosBundleIdentifier}`,
    enablePushNotifications: pushEnabled,
    // Frequent updates need the iOS entitlement to avoid early throttling.
    frequentUpdates: true,
    enableAndroid: true,
    widgets: [
      {
        name: "SubscriptionUsage",
        displayName: "Subscription usage",
        description: "Subscription quotas from your connected S2Code environments.",
        ios: {
          configuration: {
            title: "Subscription usage",
            description:
              "Both shows Session and Weekly when available. The Lock Screen shows the tightest selected limit.",
            parameters: {
              codexPeriod: {
                title: "Codex limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
              claudePeriod: {
                title: "Claude limits",
                type: "enum",
                default: "auto",
                values: [
                  { name: "Both", value: "auto" },
                  { name: "Session", value: "session" },
                  { name: "Weekly", value: "weekly" },
                ],
              },
            },
          },
          supportedFamilies: [
            "systemSmall",
            "systemMedium",
            "systemLarge",
            "systemExtraLarge",
            "accessoryRectangular",
          ],
        },
        android: {
          minWidth: 250,
          minHeight: 180,
          targetCellWidth: 4,
          targetCellHeight: 3,
          resizeMode: "both",
          // The embedded layout renders before first launch; publishing replaces it with stored props.
          initialLayout: "./src/widgets/SubscriptionUsage.android.tsx",
        },
      },
      {
        name: "AgentActivity",
        displayName: "Agent Activity",
        description: "Shows the current state of active S2Code agents.",
        // Live Activity companion; there is no Android presentation for it.
        android: null,
        ios: { supportedFamilies: ["systemSmall", "systemMedium", "accessoryRectangular"] },
      },
    ],
  },
];

const sharingPlugin: NonNullable<ExpoConfig["plugins"]>[number] = [
  "expo-sharing",
  {
    ios: {
      // Personal Teams cannot sign App Groups or extension targets; keep local builds usable.
      enabled: !isIosPersonalTeamBuild,
      extensionBundleIdentifier: `${iosBundleIdentifier}.sharing`,
      appGroupId: `group.${iosBundleIdentifier}`,
      activationRule: {
        supportsText: true,
        supportsWebUrlWithMaxCount: 1,
        supportsImageWithMaxCount: 8,
        supportsMovieWithMaxCount: 8,
        supportsFileWithMaxCount: 8,
      },
    },
    android: {
      enabled: true,
      singleShareMimeTypes: ["*/*"],
      multipleShareMimeTypes: ["*/*"],
    },
  },
];

// Match iOS PostScript names on Android so RN and the native composer share fonts before runtime loading.

const config: ExpoConfig = {
  name: variant.appName,
  slug: MOBILE_SLUG,
  platforms: ["ios", "android"],
  scheme: [variant.scheme, variant.legacyScheme],
  version: repoEnv.T3CODE_MOBILE_VERSION ?? "2.1.0",
  runtimeVersion: {
    // Skip costly fingerprinting on dev launches; preview and production OTAs require matching native projects.
    policy: runtimeVersionPolicy,
  },
  orientation: "portrait",
  icon: variant.assets.appIcon,
  userInterfaceStyle: "automatic",
  updates: {
    enabled: repoEnv.MOBILE_UPDATES_ENABLED === "1" && Boolean(expoIdentity.projectId),
    ...(expoIdentity.projectId ? { url: `https://u.expo.dev/${expoIdentity.projectId}` } : {}),
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
  },
  ios: {
    icon: variant.assets.iosIcon,
    supportsTablet: true,
    requireFullScreen: process.env.T3_SHOWCASE_CAPTURE_BUILD === "1",
    bundleIdentifier: iosBundleIdentifier,
    ...(localBuildNumber ? { buildNumber: String(localBuildNumber) } : {}),
    // Configure the fork's signing team explicitly for non-interactive builds.
    ...(appleTeamId ? { appleTeamId } : {}),
    associatedDomains: mobileAuthDomains(repoEnv),
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${iosBundleIdentifier}`],
    },
    infoPlist: {
      CFBundleDisplayName: variant.displayName,
      UISupportedInterfaceOrientations: [
        "UIInterfaceOrientationPortrait",
        "UIInterfaceOrientationLandscapeLeft",
        "UIInterfaceOrientationLandscapeRight",
      ],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow S2Code to connect to servers on your local network or tailnet.",
      NSPhotoLibraryAddUsageDescription: "Allow S2Code to save images to your photo library.",
      // System picture in picture needs background audio to start and survive outside the app.
      UIBackgroundModes: ["audio"],
      ITSAppUsesNonExemptEncryption: false,
      // Capture builds disable multitasking because iPadOS otherwise ignores orientation requests.
      ...(process.env.T3_SHOWCASE_CAPTURE_BUILD === "1"
        ? {
            "UISupportedInterfaceOrientations~ipad": [
              "UIInterfaceOrientationPortrait",
              "UIInterfaceOrientationPortraitUpsideDown",
              "UIInterfaceOrientationLandscapeLeft",
              "UIInterfaceOrientationLandscapeRight",
            ],
          }
        : {}),
    },
  },
  android: {
    icon: variant.assets.appIcon,
    package: variant.androidPackage,
    ...(localBuildNumber ? { versionCode: localBuildNumber } : {}),
    ...(googleServicesFile ? { googleServicesFile } : {}),
    adaptiveIcon: {
      backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
      ...(variant.assets.androidAdaptiveBackgroundImage
        ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
        : {}),
      foregroundImage: variant.assets.androidAdaptiveForeground,
      monochromeImage: variant.assets.androidMonochromeIcon,
    },
    // JS back dispatch needs RN's Android 16 shim and withAndroidPredictiveBackCompat on Android 13-15.
    predictiveBackGestureEnabled: true,
    // expo-sensors declares this for its pedometer, which the app does not use.
    blockedPermissions: ["android.permission.ACTIVITY_RECOGNITION"],
  },
  web: {
    favicon: variant.assets.appIcon,
  },
  plugins: [
    "expo-asset",
    "react-native-pdf-jsi",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    "expo-secure-store",
    "expo-sqlite",
    ...(isIosPersonalTeamBuild
      ? [sharingPlugin]
      : ["./plugins/withShareExtensionDisplayName.cjs", sharingPlugin]),
    ...(pushEnabled
      ? [
          [
            "expo-notifications",
            {
              icon: variant.assets.androidNotificationIcon,
              color: variant.assets.androidNotificationColor,
              mode: APP_VARIANT === "development" ? "development" : "production",
            },
          ] as NonNullable<ExpoConfig["plugins"]>[number],
        ]
      : []),
    // Gate Clerk here: withoutIosPersonalTeamCapabilities runs too early to strip its entitlement.
    [
      "@clerk/expo",
      { theme: "./clerk-theme.json", appleSignIn: authEnabled && !isIosPersonalTeamBuild },
    ],
    "expo-web-browser",
    [
      "expo-quick-actions",
      {
        androidIcons: {
          shortcut_icon: {
            foregroundImage: variant.assets.androidAdaptiveForeground,
            backgroundColor: variant.assets.androidAdaptiveBackgroundColor,
            ...(variant.assets.androidAdaptiveBackgroundImage
              ? { backgroundImage: variant.assets.androidAdaptiveBackgroundImage }
              : {}),
          },
        },
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow S2Code to use your microphone for voice input.",
        recordAudioAndroid: false,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Allow S2Code to access your camera so you can scan pairing QR codes.",
        microphonePermission: false,
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    ["expo-image-picker", { photosPermission: false, microphonePermission: false }],
    [
      "expo-splash-screen",
      {
        image: variant.assets.splashIcon,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        imageWidth: 220,
        dark: {
          image: variant.assets.splashIcon,
          backgroundColor: "#0a0a0a",
        },
        android: {
          // Android 12+ masks the central two thirds of the 288dp canvas; adaptive layers avoid clipped corners.
          image: variant.assets.androidSplashIcon,
          imageWidth: 288,
          dark: { image: variant.assets.androidSplashIcon },
        },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 24,
          // SDK 58 lacks Kotlin 2.3's runtime-inert annotation. R8 needs explicit InputMerger constructors for widgets.
          extraProguardRules: [
            "-dontwarn kotlin.MustUseReturnValues",
            "-keep class * extends androidx.work.InputMerger { <init>(); }",
          ].join("\n"),
        },
        ios: {
          deploymentTarget: "18.0",
          // AppCheckCore 11.3+ includes Swift and needs module maps for these Objective-C dependencies.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    // Compile out the unused pedometer to avoid an iOS motion purpose string.
    ["expo-sensors", { motionPermission: false }],
    // Mods run in reverse order; expo-widgets must create and wipe the target before assets are added.
    ...(!isIosPersonalTeamBuild ? ["./plugins/withWidgetLogoAsset.cjs", widgetsPlugin] : []),
    // Order-independent: only needs the iOS app target, which the template provides.
    [
      "./plugins/withT3Watch.cjs",
      {
        // The watch app never reads the App Group, and automatic signing does not
        // attach one to its App ID, so requesting it only breaks device signing.
        groupIdentifier: null,
        displayName: variant.displayName,
        iconProject: variant.assets.iosIcon,
      },
    ],
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidNetworkSecurityConfig.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidInputBackground.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
    "./plugins/withAndroidTabletOrientation.cjs",
    "./plugins/withAndroidDisplayName.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withoutIosPersonalTeamCapabilities.cjs"] : []),
  ],
  extra: {
    displayName: variant.displayName,
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    pushEnabled,
    relay: {
      url: forkHostedOrigin(repoEnv.MOBILE_RELAY_URL),
    },
    clerk: {
      publishableKey: authEnabled
        ? forkClerkPublishableKey(repoEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY)
        : null,
      jwtTemplate: repoEnv.EXPO_PUBLIC_CLERK_JWT_TEMPLATE ?? null,
    },
    // Clerk reads these exact names at prebuild. Omit unset values: manifest null becomes truthy {}.
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: authEnabled
      ? repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID
      : undefined,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: authEnabled
      ? repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID
      : undefined,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: authEnabled
      ? repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID
      : undefined,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: authEnabled
      ? repoEnv.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME
      : undefined,
    observability: {
      tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces",
      tracesDataset: repoEnv.EXPO_PUBLIC_OTLP_TRACES_DATASET ?? null,
      tracesToken: repoEnv.EXPO_PUBLIC_OTLP_TRACES_TOKEN ?? null,
    },
    ...(expoIdentity.projectId
      ? {
          eas: {
            projectId: expoIdentity.projectId,
            observe: { endpointUrl: observeEndpointUrl },
          },
        }
      : {}),
  },
  ...(expoIdentity.owner ? { owner: expoIdentity.owner } : {}),
  experiments: {
    // Metro only runs babel-plugin-react-compiler when this is set; see src/reactCompilerCoverage.test.ts.
    reactCompiler: true,
  },
};

export default config;
