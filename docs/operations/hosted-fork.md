# Fork-owned Connect relay

This fork supports deploying its own hosted Connect relay (`infra/relay`) under
fork-owned accounts. The fork's primary deployment shape is **Cloudflare Workers
plus one self-hosted VM (such as an exe.dev box) running Postgres**, reached by
Cloudflare Hyperdrive through an outbound `cloudflared` Cloudflare Tunnel
protected by a Cloudflare Access service token (`AccessOrigin`), with **no
PlanetScale or Axiom accounts required**. Upstream's PlanetScale and Axiom
paths remain intact and selectable by config.

With no variables configured, behavior stays unchanged: Connect is disabled,
nightly builds ship cloudless, direct and Tailscale pairing stay untouched, and
push-triggered relay deploys skip without failing.

Direct and Tailscale pairing remain available independently of Connect. With no
hosted web origin configured, pairing uses the server's same-origin
`/pair#token=…` URL without a `host` query, and `s2code connect` uses Clerk's
device-authorization flow. Upstream hosted origins (`t3.codes`, `t3coderelay.com`,
`t3tools.com`, `ping.gg`) and upstream Clerk keys are always rejected.

## What stays off

- **Hosted web (`web-preview.yml`, Vercel):** Notice-only; no hosted static web
  app is deployed in this setup.
- **Relay PR previews (`relay-preview.yml`, `relay-preview-cleanup.yml`):** Every
  job is gated on `github.repository == 'shuv1337/s2code' && vars.RELAY_PREVIEWS_ENABLED == 'true'`.
  External Postgres mode only supports the `prod` stage (previews require PlanetScale branching).
- **Mobile push, mobile telemetry, and store builds:** `APNS_ENABLED` defaults
  to `false`; no APNs or FCM secrets are required. When `AXIOM_TOKEN` is unset,
  no Axiom datasets/tokens or R2 source-map buckets are created, mobile observe
  endpoints answer `503 mobile_telemetry_not_configured`, and client builds stay
  free of tracing tokens.
- **T3 Chat account linking and Axiom paging monitors:** Left unset (`T3CHAT_LINK_SECRET`,
  `RELAY_ALERT_NOTIFIER_ID`, `RELAY_WARNING_NOTIFIER_ID`).

## Deployment durability: mint key and Postgres backups

`.github/workflows/deploy-relay.yml` deploys Alchemy stage `prod` from
`shuv1337/s2code` `refs/heads/main` inside the protected `production` GitHub
environment. Before `Alchemy.Stack` constructs providers or state,
`infra/relay/src/forkOwnership.ts` validates `CLOUDFLARE_ACCOUNT_ID` (32-char
hex, pinned on `Cloudflare.state({ accountId })`), non-upstream/non-placeholder
relay zones/domain, a fork-owned `CLERK_PUBLISHABLE_KEY`, and that either
external Postgres (`RELAY_DB_HOST`) or PlanetScale (`PLANETSCALE_ORGANIZATION`)
is configured.

- **Mint key pair (`CloudMintKeyPair`):** Generated once by Alchemy and stored
  in Cloudflare Alchemy state. Released S2Code servers pin
  `T3CODE_CLOUD_MINT_PUBLIC_KEY` and refuse any relay link whose mint key does
  not match. **Do not destroy `T3CodeRelay/prod` state**: rotating
  `CloudMintKeyPair` breaks every already-shipped pinned client and existing
  environment link until a new release ships with the replacement
  `T3CODE_CLOUD_MINT_PUBLIC_KEY` and environments relink.
- **Self-hosted Postgres backups and loss impact:** Backups of the Postgres
  database on the self-hosted box are the operator's responsibility. If that
  database is lost, all persisted environment links, environment credentials,
  managed tunnel allocations, and DPoP/activity state are lost: every linked
  host must relink, and previously provisioned Cloudflare tunnels and DNS
  records become orphaned until swept (see `vp run --filter t3code-relay tunnels:census`).

## External Postgres migrations

In external mode (`RELAY_DB_HOST` set), `deploy-relay.yml` runs
`vp run --filter t3code-relay migrate:postgres` before deploying the Worker,
applying `infra/relay/migrations/postgres` and recording applied files in
`relay_migrations` using the same schema and SHA-256 bookkeeping as
`@alchemy.run/planetscale` (so a database can move cleanly between modes). When
`RELAY_DB_ACCESS_CLIENT_ID` and `RELAY_DB_ACCESS_CLIENT_SECRET` are set, the
workflow reaches the private Postgres box over `cloudflared access tcp` using
the same Access service token.

The same script can also be run directly on the database box:

```sh
RELAY_DATABASE_URL="postgresql://<user>:<password>@127.0.0.1:5432/<db>?sslmode=disable" \
  vp run --filter t3code-relay migrate:postgres
```

## GitHub variables and secrets

### `production` environment (deploy-only)

Only `.github/workflows/deploy-relay.yml` enters `environment: production`.
Release workflows (`release.yml`, `release-desktop.yml`,
`encrypted-windows-build.yml`) never enter `production` and never see deploy
credentials.

Required core secrets in `production`:

- `CLOUDFLARE_API_TOKEN`
- `CLERK_SECRET_KEY` (relay Worker only; never exposed to clients or releases)

Required core variables in `production`:

- `CLOUDFLARE_ACCOUNT_ID` (32-character hex Cloudflare account ID)
- `RELAY_API_ZONE_NAME` (set at repository scope as well to enable automatic
  path-filtered `push` deploys on `main`; keeping it only in `production` limits
  deploys to `workflow_dispatch`)
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` _(optional override for `relay.<RELAY_API_ZONE_NAME>`)_
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE` (`t3-code-relay`)
- `APNS_ENABLED` _(optional; defaults to `false`)_
- `RELAY_TUNNEL_CLEANUP_MODE` _(optional; start `off`, verify `dry-run`, then `enabled`)_
- `RELAY_LEGACY_TUNNEL_CLEANUP_MODE` _(optional; default `off`)_

Self-hosted Postgres mode (recommended for this fork; selected whenever `RELAY_DB_HOST` is set):

- Variables: `RELAY_DB_HOST` (tunnel/Access hostname), `RELAY_DB_NAME`,
  `RELAY_DB_USER`, optional `RELAY_DB_PORT` (public origin only; default `5432`),
  optional `RELAY_DB_CONNECTION_LIMIT` (default `20`)
- Secrets: `RELAY_DB_PASSWORD`, plus `RELAY_DB_ACCESS_CLIENT_ID` and
  `RELAY_DB_ACCESS_CLIENT_SECRET` (set both for Cloudflare Tunnel + Access
  `AccessOrigin`, or leave both unset for `PublicOrigin`; setting only one fails)

Optional self-hosted Worker OTLP traces (used when `AXIOM_TOKEN` is unset):

- Variable: `RELAY_OTLP_TRACES_URL` (fork-owned HTTPS OTLP/HTTP traces endpoint)
- Secret: `RELAY_OTLP_TRACES_TOKEN` _(optional bearer token)_

Optional upstream-compatible PlanetScale + Axiom mode (leave unset on the self-hosted stack):

- PlanetScale variables: `PLANETSCALE_ORGANIZATION`, optional
  `RELAY_DB_CLUSTER_SIZE` (default `PS_5`), optional `RELAY_DB_REPLICAS` (default `0`),
  optional `RELAY_DB_CONNECTION_LIMIT` (default `40`)
- PlanetScale secrets: `PLANETSCALE_API_TOKEN_ID`, `PLANETSCALE_API_TOKEN`
- Axiom variable/secret: `AXIOM_ORG_ID` (variable), `AXIOM_TOKEN` (secret)

### Repository variables (public release build config)

`release.yml` (preflight, `build_bundle`, and every `release-desktop.yml`
caller) and `encrypted-windows-build.yml` read these public non-secret
repository variables. The five required variables are validated all-or-nothing:
leaving all unset produces a cloudless build, while a partial set fails
preflight.

- `T3CODE_RELAY_URL` (from the `deploy-relay.yml` step summary)
- `T3CODE_CLOUD_MINT_PUBLIC_KEY` (single-line `\n`-escaped Ed25519 SPKI PEM from
  the `deploy-relay.yml` step summary)
- `T3CODE_CLERK_PUBLISHABLE_KEY`
- `T3CODE_CLERK_JWT_TEMPLATE` (`t3-relay`)
- `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`
- `T3CODE_HOSTED_APP_URL` _(optional; omit when no hosted web app is deployed)_

## Inherited marketing references

The marketing source retains T3 Code's `/legal`, `/privacy-policy`,
`/terms-of-service`, and `/security-policy` pages as explicitly labeled upstream
references. Their company names, service descriptions, dates, and policy claims
describe T3 Tools and T3 Code; they are not S2Code policies. Do not turn them into
fork policies by replacing product names or configuration examples. Fork telemetry
controls are documented separately in the [product usage guide](../user/telemetry.md).

The `/95` page is an inherited upstream promotional demo. Its artwork, terminal
command, and developer-count claims describe T3 Code. It is labeled
as an upstream reference and its T3 Code download/source links stay upstream.
The main fork page likewise attributes inherited user counts and testimonials to
T3 Code; screenshot descriptions may name the upstream product shown. These
references do not establish fork service ownership or a published S2Code website.

## Client configuration names

These are the internal names the binaries and builds read. Leave hosted settings
unset for cloudless local builds. Public `S2CODE_*` CLI environment aliases
(including `S2CODE_CLOUD_MINT_PUBLIC_KEY`, `S2CODE_RELAY_URL`,
`S2CODE_HOSTED_APP_URL`, `S2CODE_CLERK_*`) are normalized to the corresponding
`T3CODE_*` inputs at the process boundary; they are not substitutes for Vite or
Expo build inputs.

- Server runtime and bundled defaults: `T3CODE_RELAY_URL`,
  `T3CODE_CLOUD_MINT_PUBLIC_KEY`, `T3CODE_CLERK_PUBLISHABLE_KEY`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, and optional `T3CODE_HOSTED_APP_URL`.
  `T3CODE_CLOUD_MINT_PUBLIC_KEY` is the relay's Ed25519 credential-minting
  public key (PEM, single-line `\n`-escaped in `.env` and CI variables). An
  environment refuses a relay link for any other relay URL or mint key.
- Desktop build auth: `T3CODE_CLERK_PUBLISHABLE_KEY`,
  `T3CODE_CLERK_JWT_TEMPLATE`. Signed macOS builds only enable Associated Domains
  passkeys when `T3CODE_MACOS_PROVISIONING_PROFILE` or
  `T3CODE_CLERK_PASSKEY_RP_DOMAINS` is set.
- Web build: `VITE_T3CODE_RELAY_URL`, `VITE_CLERK_PUBLISHABLE_KEY`,
  `VITE_CLERK_JWT_TEMPLATE`, optional `VITE_HOSTED_APP_URL`,
  `VITE_HOSTED_APP_CHANNEL`. Optional relay tracing:
  `VITE_RELAY_OTLP_TRACES_URL`, `VITE_RELAY_OTLP_TRACES_DATASET`,
  `VITE_RELAY_OTLP_TRACES_TOKEN`.
- Mobile build: `T3CODE_RELAY_URL`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`,
  `EXPO_PUBLIC_CLERK_JWT_TEMPLATE`. Optional tracing:
  `EXPO_PUBLIC_OTLP_TRACES_URL`, `EXPO_PUBLIC_OTLP_TRACES_DATASET`,
  `EXPO_PUBLIC_OTLP_TRACES_TOKEN`. Mobile delivery/feature flags remain governed
  by the mobile release runbook.

No credentials belong in public configuration except service-scoped public
client keys/tokens intended for distribution.
