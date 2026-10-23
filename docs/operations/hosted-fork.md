# Hosted services are disabled

This fork does not run hosted web or Connect services. The web-preview and relay
workflows only emit a notice and summary: no build, deploy, credential lookup or
resource provisioning occurs. The Alchemy entry point also refuses execution,
including local invocations. There is no supported enable flag. CLI/desktop
publication is independent of hosted deployment.

Direct and Tailscale pairing remain available. With no hosted origin configured,
pairing uses the server's same-origin `/pair#token=…` URL without a `host` query.
Upstream hosted origins and auth accounts are not fork defaults.

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

These are the internal names the binaries/builds actually read, not deployment
switches. Leave hosted settings unset for normal fork use. Public `S2CODE_*`
CLI environment aliases are normalized to the corresponding `T3CODE_*` inputs
at the process boundary; they are not substitutes for Vite or Expo build inputs.

- Server runtime and bundled defaults: `T3CODE_HOSTED_APP_URL`,
  `T3CODE_RELAY_URL`, `T3CODE_CLOUD_MINT_PUBLIC_KEY`,
  `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. The
  server build bakes the hosted origin from `T3CODE_HOSTED_APP_URL`, the same
  name used at runtime. `T3CODE_CLOUD_MINT_PUBLIC_KEY` is the relay's Ed25519
  credential-minting public key (PEM). An environment refuses a relay link
  for any other relay URL or mint key, so set both or hosted linking fails.
- Desktop build auth: `T3CODE_CLERK_PUBLISHABLE_KEY`,
  `T3CODE_CLERK_JWT_TEMPLATE`.
- Web build: `VITE_HOSTED_APP_URL`, `VITE_HOSTED_APP_CHANNEL`,
  `VITE_T3CODE_RELAY_URL`, `VITE_CLERK_PUBLISHABLE_KEY`,
  `VITE_CLERK_JWT_TEMPLATE`. Optional relay tracing:
  `VITE_RELAY_OTLP_TRACES_URL`, `VITE_RELAY_OTLP_TRACES_DATASET`,
  `VITE_RELAY_OTLP_TRACES_TOKEN`.
- Mobile build: `T3CODE_RELAY_URL`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`,
  `EXPO_PUBLIC_CLERK_JWT_TEMPLATE`. Optional tracing:
  `EXPO_PUBLIC_OTLP_TRACES_URL`, `EXPO_PUBLIC_OTLP_TRACES_DATASET`,
  `EXPO_PUBLIC_OTLP_TRACES_TOKEN`. Mobile delivery/feature flags remain governed
  by the mobile release runbook.

No credentials belong in public configuration except service-scoped public
client keys/tokens intended for distribution.

## Prerequisites for future enablement

Separate maintainer authorization and implementation are required. Prerequisite
areas: fork domains/DNS, Clerk instance/OAuth redirects, Vercel project/Git link,
Cloudflare account, PlanetScale organization, Axiom organization, resource/state
namespaces, credential scoping, protected deployment environments, ownership
verification and platform sign-in/delivery checks. Optional push: APNs and FCM.
None of these checks or deployments is implemented by the disabled workflows.
