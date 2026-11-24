import {
  connectLoopbackRedirectUri,
  CONNECT_OAUTH_SCOPES,
  DEFAULT_HOSTED_APP_URL,
} from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import type { RelayClientTracingConfig } from "@t3tools/shared/relayTracing";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { forkHostedOrigin, forkClerkPublishableKey } from "@t3tools/shared/hostedConfig";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_CLOUD_MINT_PUBLIC_KEY__: string | undefined;
declare const __T3CODE_BUILD_HOSTED_APP_URL__: string | undefined;
declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;

const CLOUD_CLI_OAUTH_LOOPBACK_PORT = 34338;
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = forkHostedOrigin(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);
const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);

export function resolveRelayClientTracingConfig(
  _env: Readonly<Record<string, string | undefined>> = process.env,
  _fallback?: {
    readonly tracesUrl: string;
    readonly tracesDataset: string;
    readonly tracesToken: string;
  },
): RelayClientTracingConfig | null {
  return null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.NonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapEffect(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

const buildTimeCloudMintPublicKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLOUD_MINT_PUBLIC_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLOUD_MINT_PUBLIC_KEY__,
);

/**
 * The relay's credential-minting key, pinned beside its URL. A relay config
 * carrying any other key is refused, so a client cannot plant its own.
 */
function makeCloudMintPublicKeyConfig(fallback = buildTimeCloudMintPublicKey) {
  const runtimeConfig = Config.NonEmptyString("T3CODE_CLOUD_MINT_PUBLIC_KEY");
  return fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig;
}

export const cloudMintPublicKeyConfig = makeCloudMintPublicKeyConfig();

const buildTimeHostedAppUrl = readBuildTimeValue(
  typeof __T3CODE_BUILD_HOSTED_APP_URL__ === "undefined"
    ? DEFAULT_HOSTED_APP_URL
    : __T3CODE_BUILD_HOSTED_APP_URL__,
);

export const hostedAppUrlConfig = makePublicValueConfig(
  "T3CODE_HOSTED_APP_URL",
  buildTimeHostedAppUrl,
).pipe(Config.mapEffect(validateHostedAppUrl));

/** `None` only when unset or blank; any non-empty value still fails closed if invalid or upstream. */
export function makeOptionalHostedAppUrlConfig(fallback = buildTimeHostedAppUrl) {
  return Config.String("T3CODE_HOSTED_APP_URL").pipe(
    Config.option,
    Config.mapEffect((runtime) => {
      const raw = Option.isSome(runtime) ? runtime.value.trim() : fallback.trim();
      if (raw.length === 0) {
        return Effect.succeed(Option.none<string>());
      }
      return validateHostedAppUrl(raw).pipe(Effect.asSome);
    }),
  );
}

export const optionalHostedAppUrlConfig = makeOptionalHostedAppUrlConfig();

function validateHostedAppUrl(value: string) {
  try {
    const origin = forkHostedOrigin(value, true);
    if (!origin) throw new Error("Hosted origin is unavailable or not fork-owned.");
    const url = new URL(origin);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.NonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export interface CloudCliOAuthConfig {
  readonly tokenEndpoint: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly loopbackPort: number;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
} = {}) {
  return Config.all({
    clerkPublishableKey: makePublicValueConfig(
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      clerkPublishableKeyFallback,
    ),
    clientId: makePublicValueConfig(
      "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      clerkCliOAuthClientIdFallback,
    ),
  }).pipe(
    Config.mapEffect(({ clerkPublishableKey, clientId }) =>
      Effect.try({
        try: () => {
          if (!forkClerkPublishableKey(clerkPublishableKey))
            throw new Error("Fork auth application is unconfigured or targets upstream.");
          return clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey);
        },
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Failed to derive Clerk Frontend API URL from the publishable key.",
              cause,
            }),
          ),
      }).pipe(
        Effect.map(
          (clerkFrontendApiUrl) =>
            ({
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              deviceAuthorizationEndpoint: `${clerkFrontendApiUrl}/oauth/device_authorization`,
              clientId,
              loopbackPort: CLOUD_CLI_OAUTH_LOOPBACK_PORT,
              redirectUri: connectLoopbackRedirectUri(CLOUD_CLI_OAUTH_LOOPBACK_PORT),
              scopes: CLOUD_CLI_OAUTH_SCOPES,
            }) satisfies CloudCliOAuthConfig,
        ),
      ),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export function isCloudPublicConfigConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallbacks: {
    readonly relayUrl?: string;
    readonly cloudMintPublicKey?: string;
    readonly clerkPublishableKey?: string;
    readonly clerkCliOAuthClientId?: string;
  } = {
    relayUrl: buildTimeRelayUrl,
    cloudMintPublicKey: buildTimeCloudMintPublicKey,
    clerkPublishableKey: buildTimeClerkPublishableKey,
    clerkCliOAuthClientId: buildTimeClerkCliOAuthClientId,
  },
): boolean {
  return Boolean(
    forkHostedOrigin(env.T3CODE_RELAY_URL?.trim() || fallbacks.relayUrl?.trim()) &&
    (env.T3CODE_CLOUD_MINT_PUBLIC_KEY?.trim() || fallbacks.cloudMintPublicKey?.trim()) &&
    forkClerkPublishableKey(
      env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || fallbacks.clerkPublishableKey?.trim(),
    ) &&
    (env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || fallbacks.clerkCliOAuthClientId?.trim()),
  );
}

export const hasCloudPublicConfig = isCloudPublicConfigConfigured();
