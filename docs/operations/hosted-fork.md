# Enable a fork-owned hosted service

Hosted web and Connect are intentionally unavailable in this fork. Do not point
clients or deployment jobs at upstream accounts, domains, resource state or OAuth
applications. CLI/desktop publication is independent: the #270 release pipeline
does not invoke hosted jobs. No external setup is performed by these guards.

Before enabling deployment, supply these **repository variables** (not values
in the inherited upstream `production` environment):

- Opt-in: `FORK_HOSTED_ENABLED`.
- Router/channels: `SHUV2CODE_HOSTED_APP_URL`, `SHUV2CODE_WEB_LATEST_DOMAIN`,
  `SHUV2CODE_WEB_NIGHTLY_DOMAIN`.
- Auth/redirects: `SHUV2CODE_AUTH_DOMAIN`, `CLERK_PUBLISHABLE_KEY`,
  `CLERK_JWT_TEMPLATE`, `CLERK_JWT_AUDIENCE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `CLERK_OAUTH_APPLICATION_ID`,
  `FORK_HOSTED_REDIRECT_ORIGINS`.
- Relay domains: `RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`.
- Resource identities: `FORK_CLOUDFLARE_ACCOUNT_ID`,
  `FORK_PLANETSCALE_ORGANIZATION`, `FORK_AXIOM_ORG_ID`, `FORK_VERCEL_ORG_ID`,
  `FORK_VERCEL_PROJECT_ID`.
- Optional relay settings: `RELAY_TUNNEL_CLEANUP_MODE`, `FORK_APNS_ENABLED`, `FORK_PUSH_ENABLED`;
  notification settings are covered by the mobile/push runbooks.

Required secret names are `FORK_CLERK_SECRET_KEY`, `FORK_CLOUDFLARE_API_TOKEN`,
`FORK_PLANETSCALE_API_TOKEN_ID`, `FORK_PLANETSCALE_API_TOKEN`, `FORK_AXIOM_TOKEN`, and
`FORK_VERCEL_TOKEN`. Never put private credentials in public client settings.
Optional relay push uses `FORK_APNS_ENVIRONMENT`, `FORK_APNS_TEAM_ID`,
`FORK_APNS_KEY_ID`, `FORK_APNS_BUNDLE_ID`, `FORK_APNS_PRIVATE_KEY`, and
`FORK_FCM_SERVICE_ACCOUNT`; inherited upstream push credentials are not reused.

The opt-in must be explicitly enabled. The redirect-origin variable is a JSON
array covering the router and both channel origins. The Clerk key must identify
the declared fork auth domain; the public CLI OAuth application must require PKCE
and register the loopback callback used by the CLI. Configure browser/native
redirects in that same fork auth instance before enabling clients.

The reusable hosted preflight skips missing or upstream configuration with a
notice and step summary, before any deployment job starts. For configured jobs it
performs read-only Clerk OAuth, Vercel project/team or Cloudflare zone/account
identity checks. Mismatch or lookup failure blocks deployment. Tokens and remote
responses are never printed. The relay stack/database/tunnel namespace is
fork-owned; legacy tunnel cleanup is disabled. No upstream state is migrated.

Use the guarded relay and web-preview workflows only after provisioning the
declared resources and confirming permissions. Automatic upstream Vercel Git
deployments remain disabled. Production web publication is not part of the fork
release pipeline and requires a separately approved deployment workflow.

Client configuration is separate from provisioning. Configure
`SHUV2CODE_HOSTED_APP_URL`, `SHUV2CODE_RELAY_URL`,
`SHUV2CODE_CLERK_PUBLISHABLE_KEY`, `SHUV2CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and
`SHUV2CODE_CLERK_JWT_TEMPLATE` for a server. Web/mobile builds must receive the
corresponding public origin, relay and auth settings; follow the mobile release
runbook for its explicit feature flags. A domain/key declaration is not proof of
successful user sign-in, store delivery or a reachable tunnel: verify those on
the intended platforms before advertising hosted availability.
