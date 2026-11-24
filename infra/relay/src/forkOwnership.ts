import * as Alchemy from "alchemy";
import { forkClerkPublishableKey, forkHostedOrigin } from "@t3tools/shared/hostedConfig";
import { PRODUCT_RELEASE_REPOSITORY } from "@t3tools/shared/productIdentity";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const PLACEHOLDER_DOMAINS = ["example.com", "example.net", "example.org"] as const;
const PLACEHOLDER_TLDS = [".example", ".invalid", ".test"] as const;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const FORBIDDEN_FEEDBACK_GITHUB_OWNERS = new Set([
  "pingdotgg",
  "t3tools",
  "t3-oss",
  "example",
  "test",
  "invalid",
]);

export interface ForkRelayDeploymentEnv {
  readonly cloudflareAccountId: string;
  readonly relayApiZoneName: string;
  readonly relayTunnelZoneName: string;
  readonly relayDomain: string | undefined;
  readonly clerkPublishableKey: string;
  readonly databaseBackend: "planetscale" | "external";
  readonly observabilityBackend: "axiom" | "none";
}

/**
 * Strip Alchemy's Worker `RuntimeContext` around deploy-only `Config.*` reads so
 * `Platform.ts` does not bind deploy-time secrets/vars onto the public Worker env.
 */
export const withoutWorkerConfigCapture = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.updateContext(
    effect,
    Context.omit(Alchemy.RuntimeContext) as (ctx: Context.Context<R>) => Context.Context<R>,
  );

function isPlaceholderDomain(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/u, "");
  return (
    PLACEHOLDER_DOMAINS.some((root) => host === root || host.endsWith(`.${root}`)) ||
    PLACEHOLDER_TLDS.some((tld) => host.endsWith(tld))
  );
}

export function assertForkRelayHost(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`${name} is required for fork relay deployment.`);
  }
  const normalized = trimmed.toLowerCase().replace(/\.+$/u, "");
  const origin = forkHostedOrigin(`https://${normalized}`);
  if (
    origin === null ||
    new URL(origin).hostname !== normalized ||
    !normalized.includes(".") ||
    isPlaceholderDomain(normalized)
  ) {
    throw new Error(`${name} must be a fork-owned domain, not an upstream or placeholder host.`);
  }
  return normalized;
}

export function assertForkOtlpTracesUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("RELAY_OTLP_TRACES_URL must be a valid fork-owned HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("RELAY_OTLP_TRACES_URL must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("RELAY_OTLP_TRACES_URL must not contain embedded credentials.");
  }
  assertForkRelayHost("RELAY_OTLP_TRACES_URL", parsed.hostname);
  return parsed.toString();
}

export function assertForkFeedbackGithubRepo(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  const repo = trimmed.length > 0 ? trimmed : PRODUCT_RELEASE_REPOSITORY;
  if (!GITHUB_REPOSITORY_PATTERN.test(repo)) {
    throw new Error(
      "FEEDBACK_GITHUB_REPO must be a valid GitHub owner/repo slug (e.g. shuv1337/s2code).",
    );
  }
  const [owner, name] = repo.split("/") as [string, string];
  if (name === "." || name === ".." || FORBIDDEN_FEEDBACK_GITHUB_OWNERS.has(owner.toLowerCase())) {
    throw new Error(
      `FEEDBACK_GITHUB_REPO must target a fork-owned repository, not "${owner}/${name}".`,
    );
  }
  return repo;
}

function assertForkRelayClerkPublishableKey(value: string | undefined): string {
  const key = forkClerkPublishableKey(value);
  if (key === null) {
    throw new Error(
      "CLERK_PUBLISHABLE_KEY must be a valid fork-owned Clerk publishable key, not an upstream key.",
    );
  }
  const host = atob(key.split("_").slice(2).join("_"))
    .replace(/\$$/u, "")
    .toLowerCase()
    .replace(/\.+$/u, "");
  if (!host.includes(".") || isPlaceholderDomain(host)) {
    throw new Error("CLERK_PUBLISHABLE_KEY must not target a placeholder domain.");
  }
  return key;
}

function assertForkRelayDatabaseEnv(
  env: Readonly<Record<string, string | undefined>>,
): "planetscale" | "external" {
  const externalHost = env.RELAY_DB_HOST?.trim();
  if (externalHost) {
    assertForkRelayHost("RELAY_DB_HOST", externalHost);
    for (const key of ["RELAY_DB_NAME", "RELAY_DB_USER", "RELAY_DB_PASSWORD"] as const) {
      if (!env[key]?.trim()) {
        throw new Error(`${key} is required when RELAY_DB_HOST is set.`);
      }
    }
    const accessId = env.RELAY_DB_ACCESS_CLIENT_ID?.trim() ?? "";
    const accessSecret = env.RELAY_DB_ACCESS_CLIENT_SECRET?.trim() ?? "";
    if (accessId.length > 0 !== accessSecret.length > 0) {
      throw new Error(
        "RELAY_DB_ACCESS_CLIENT_ID and RELAY_DB_ACCESS_CLIENT_SECRET must both be set for Cloudflare Access origins.",
      );
    }
    const rawPort = env.RELAY_DB_PORT?.trim() ?? "";
    if (rawPort && accessId.length === 0) {
      const port = /^\d+$/u.test(rawPort) ? Number(rawPort) : Number.NaN;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error("RELAY_DB_PORT must be a valid TCP port (1-65535).");
      }
    }
    return "external";
  }
  if (env.PLANETSCALE_ORGANIZATION?.trim()) {
    return "planetscale";
  }
  throw new Error(
    "Configure either external Postgres (RELAY_DB_HOST) or PlanetScale (PLANETSCALE_ORGANIZATION) before deploying.",
  );
}

/** Fail closed before Alchemy constructs providers or accesses remote state. */
export function assertForkRelayDeploymentEnv(
  env: Readonly<Record<string, string | undefined>>,
): ForkRelayDeploymentEnv {
  const cloudflareAccountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  if (!CLOUDFLARE_ACCOUNT_ID_PATTERN.test(cloudflareAccountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hex Cloudflare account ID.");
  }
  const relayApiZoneName = assertForkRelayHost("RELAY_API_ZONE_NAME", env.RELAY_API_ZONE_NAME);
  const relayTunnelZoneName = assertForkRelayHost(
    "RELAY_TUNNEL_ZONE_NAME",
    env.RELAY_TUNNEL_ZONE_NAME,
  );
  const rawRelayDomain = env.RELAY_DOMAIN?.trim();
  const relayDomain = rawRelayDomain
    ? assertForkRelayHost("RELAY_DOMAIN", rawRelayDomain)
    : undefined;
  const clerkPublishableKey = assertForkRelayClerkPublishableKey(env.CLERK_PUBLISHABLE_KEY);
  const databaseBackend = assertForkRelayDatabaseEnv(env);
  const rawOtlpTracesUrl = env.RELAY_OTLP_TRACES_URL?.trim();
  if (rawOtlpTracesUrl) {
    assertForkOtlpTracesUrl(rawOtlpTracesUrl);
  }
  assertForkFeedbackGithubRepo(env.FEEDBACK_GITHUB_REPO);
  const observabilityBackend = env.AXIOM_TOKEN?.trim() ? "axiom" : "none";

  return {
    cloudflareAccountId,
    relayApiZoneName,
    relayTunnelZoneName,
    relayDomain,
    clerkPublishableKey,
    databaseBackend,
    observabilityBackend,
  };
}

const optionalConfigString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const validateForkRelayConfig = Effect.fn("ForkOwnership.validate")(function* (
  env: Readonly<Record<string, string | undefined>>,
) {
  return yield* Effect.try({
    try: () => assertForkRelayDeploymentEnv(env),
    catch: (error) =>
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message:
              error instanceof Error ? error.message : "Invalid fork relay deployment config.",
          }),
        ),
      ),
  });
});

/** Reads deployment ownership settings through Effect Config so Alchemy's `.env` loader applies. */
export const forkRelayDeploymentConfig: Config.Config<ForkRelayDeploymentEnv> = Config.all({
  CLOUDFLARE_ACCOUNT_ID: optionalConfigString("CLOUDFLARE_ACCOUNT_ID"),
  RELAY_API_ZONE_NAME: optionalConfigString("RELAY_API_ZONE_NAME"),
  RELAY_TUNNEL_ZONE_NAME: optionalConfigString("RELAY_TUNNEL_ZONE_NAME"),
  RELAY_DOMAIN: optionalConfigString("RELAY_DOMAIN"),
  CLERK_PUBLISHABLE_KEY: optionalConfigString("CLERK_PUBLISHABLE_KEY"),
  RELAY_DB_HOST: optionalConfigString("RELAY_DB_HOST"),
  RELAY_DB_PORT: optionalConfigString("RELAY_DB_PORT"),
  RELAY_DB_NAME: optionalConfigString("RELAY_DB_NAME"),
  RELAY_DB_USER: optionalConfigString("RELAY_DB_USER"),
  RELAY_DB_PASSWORD: optionalConfigString("RELAY_DB_PASSWORD"),
  RELAY_DB_ACCESS_CLIENT_ID: optionalConfigString("RELAY_DB_ACCESS_CLIENT_ID"),
  RELAY_DB_ACCESS_CLIENT_SECRET: optionalConfigString("RELAY_DB_ACCESS_CLIENT_SECRET"),
  PLANETSCALE_ORGANIZATION: optionalConfigString("PLANETSCALE_ORGANIZATION"),
  RELAY_OTLP_TRACES_URL: optionalConfigString("RELAY_OTLP_TRACES_URL"),
  FEEDBACK_GITHUB_REPO: optionalConfigString("FEEDBACK_GITHUB_REPO"),
  AXIOM_TOKEN: optionalConfigString("AXIOM_TOKEN"),
}).pipe(Config.mapEffect(validateForkRelayConfig));
