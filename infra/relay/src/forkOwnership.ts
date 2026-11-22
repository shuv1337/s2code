import { forkClerkPublishableKey, forkHostedOrigin } from "@t3tools/shared/hostedConfig";

const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const PLACEHOLDER_DOMAINS = ["example.com", "example.net", "example.org"] as const;
const PLACEHOLDER_TLDS = [".example", ".invalid", ".test"] as const;

export interface ForkRelayDeploymentEnv {
  readonly cloudflareAccountId: string;
  readonly relayApiZoneName: string;
  readonly relayTunnelZoneName: string;
  readonly relayDomain: string | undefined;
  readonly clerkPublishableKey: string;
  readonly databaseBackend: "planetscale" | "external";
  readonly observabilityBackend: "axiom" | "none";
}

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
