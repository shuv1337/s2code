import { forkHostedOrigin, forkClerkPublishableKey } from "../packages/shared/src/hostedConfig.ts";

type Environment = Readonly<Record<string, string | undefined>>;
export const RELAY_DEPLOYMENT_UNAVAILABLE_MESSAGE =
  "Relay deployment is disabled until read-only PlanetScale and Axiom organization identity verification is implemented. Credentials and opt-in alone do not permit deployment.";
export const HOSTED_DEPLOYMENT_VARIABLES = [
  "SHUV2CODE_HOSTED_APP_URL",
  "SHUV2CODE_WEB_LATEST_DOMAIN",
  "SHUV2CODE_WEB_NIGHTLY_DOMAIN",
  "SHUV2CODE_AUTH_DOMAIN",
  "FORK_HOSTED_REDIRECT_ORIGINS",
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_CLI_OAUTH_CLIENT_ID",
  "CLERK_OAUTH_APPLICATION_ID",
  "CLERK_JWT_TEMPLATE",
  "CLERK_JWT_AUDIENCE",
  "RELAY_DOMAIN",
  "RELAY_API_ZONE_NAME",
  "RELAY_TUNNEL_ZONE_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "PLANETSCALE_ORGANIZATION",
  "AXIOM_ORG_ID",
  "VERCEL_ORG_ID",
  "VERCEL_PROJECT_ID",
] as const;

/** A configuration declaration is not proof of remote ownership; verify identities before mutation. */
export function hostedDeploymentConfiguration(env: Environment) {
  if (env.FORK_HOSTED_ENABLED !== "1")
    throw new Error("FORK_HOSTED_ENABLED is not enabled; hosted deployment is unavailable.");
  for (const name of HOSTED_DEPLOYMENT_VARIABLES)
    if (!env[name]?.trim()) throw new Error(`Hosted deployment requires ${name}.`);
  const origin = (name: string, domain = false) => {
    const value = env[name]!.trim();
    const parsed = forkHostedOrigin(domain ? `https://${value}` : value);
    if (!parsed || (domain && new URL(parsed).host !== value.toLowerCase()))
      throw new Error(`Hosted deployment requires a fork-owned HTTPS origin/domain for ${name}.`);
    return parsed;
  };
  const app = origin("SHUV2CODE_HOSTED_APP_URL");
  const latest = origin("SHUV2CODE_WEB_LATEST_DOMAIN", true);
  const nightly = origin("SHUV2CODE_WEB_NIGHTLY_DOMAIN", true);
  if (new Set([app, latest, nightly]).size !== 3)
    throw new Error("Hosted router/latest/nightly origins must be distinct.");
  const auth = origin("SHUV2CODE_AUTH_DOMAIN", true);
  const key = forkClerkPublishableKey(env.CLERK_PUBLISHABLE_KEY);
  if (
    !key ||
    atob(key.split("_").slice(2).join("_")).replace(/\$$/, "").toLowerCase() !==
      new URL(auth).hostname
  )
    throw new Error("Clerk publishable key does not match SHUV2CODE_AUTH_DOMAIN.");
  const relay = origin("RELAY_DOMAIN", true);
  const apiZone = new URL(origin("RELAY_API_ZONE_NAME", true)).hostname;
  const tunnelZone = new URL(origin("RELAY_TUNNEL_ZONE_NAME", true)).hostname;
  if (!new URL(relay).hostname.endsWith(`.${apiZone}`))
    throw new Error("Relay domain does not belong to RELAY_API_ZONE_NAME.");
  const redirects: unknown = JSON.parse(env.FORK_HOSTED_REDIRECT_ORIGINS!);
  if (
    !Array.isArray(redirects) ||
    redirects.some((value) => typeof value !== "string" || !forkHostedOrigin(value)) ||
    ![app, latest, nightly].every((value) => redirects.includes(value))
  )
    throw new Error(
      "Fork auth redirect origins must include router/latest/nightly and exclude upstream.",
    );
  return { app, latest, nightly, auth, relay, apiZone, tunnelZone };
}

const record = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid hosted destination identity response.");
  return value as Record<string, unknown>;
};

/** Read-only web identity checks. Relay stays unavailable; never mutate resources or log responses. */
export async function verifyHostedDeploymentIdentities(
  env: Environment,
  target: "web" | "relay",
  request: (url: string, authorization: string) => Promise<unknown>,
) {
  const config = hostedDeploymentConfiguration(env);
  if (target === "relay") throw new Error(RELAY_DEPLOYMENT_UNAVAILABLE_MESSAGE);
  const permittedRedirectOrigins = new Set(
    JSON.parse(env.FORK_HOSTED_REDIRECT_ORIGINS!) as string[],
  );
  const secret = (name: string) => {
    if (!env[name]) throw new Error(`Hosted identity verification requires ${name}.`);
    return env[name]!;
  };
  const oauth = record(
    await request(
      `https://api.clerk.com/v1/oauth_applications/${encodeURIComponent(env.CLERK_OAUTH_APPLICATION_ID!)}`,
      `Bearer ${secret("CLERK_SECRET_KEY")}`,
    ),
  );
  if (
    oauth.id !== env.CLERK_OAUTH_APPLICATION_ID ||
    oauth.client_id !== env.CLERK_CLI_OAUTH_CLIENT_ID ||
    oauth.public !== true ||
    oauth.pkce_required !== true ||
    !Array.isArray(oauth.redirect_uris) ||
    !oauth.redirect_uris.includes("http://127.0.0.1:34338/callback") ||
    typeof oauth.authorize_url !== "string" ||
    new URL(oauth.authorize_url).origin !== config.auth ||
    oauth.redirect_uris.some(
      (uri) =>
        typeof uri !== "string" ||
        (uri !== "http://127.0.0.1:34338/callback" &&
          (!forkHostedOrigin(new URL(uri).origin) ||
            !permittedRedirectOrigins.has(new URL(uri).origin))),
    )
  )
    throw new Error(
      "Clerk OAuth application identity/PKCE/redirect configuration does not match the fork.",
    );
  if (target === "web") {
    const project = record(
      await request(
        `https://api.vercel.com/v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID!)}?teamId=${encodeURIComponent(env.VERCEL_ORG_ID!)}`,
        `Bearer ${secret("VERCEL_TOKEN")}`,
      ),
    );
    if (
      project.id !== env.VERCEL_PROJECT_ID ||
      project.accountId !== env.VERCEL_ORG_ID ||
      project.rootDirectory !== "apps/web"
    )
      throw new Error("Vercel project/team/root identity does not match the fork configuration.");
    if (project.link) {
      const link = record(project.link);
      if (link.type !== "github" || link.org !== "shuv1337" || link.repo !== "shuv2code")
        throw new Error("Vercel project is linked to another repository; no deployment attempted.");
    }
  }
  return config;
}
