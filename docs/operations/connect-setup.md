# T3 Connect setup

Deployment and client configuration for Connect. The [architecture note](../internals/t3-connect.md)
explains the trust boundaries; the [fork relay runbook](./hosted-fork.md) owns GitHub
variables/secrets and fork ownership guards; the [relay README](../../infra/relay/README.md#deployment)
owns relay provisioning details.

## Public application configuration

Connect is disabled in a fresh clone. For local source builds against a fork-owned relay,
copy `.env.example` to `.env` and fill in your deployment's public values in `.env` or `.env.local`:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=t3-relay
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.<your-domain>
T3CODE_CLOUD_MINT_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
```

Process variables take precedence over `.env.local`, then `.env`. Use these canonical names;
the build loader supplies framework-specific aliases (including `VITE_HOSTED_APP_URL` when optional
`T3CODE_HOSTED_APP_URL` is set). These values are public identifiers. `CLERK_SECRET_KEY` belongs
only in the relay's secrets, never in client configuration.

Client and bundled-server builds embed the public values, so set them before building.
Bundled servers also accept runtime overrides via `S2CODE_*` aliases for operator-managed
deployments.

Copy `infra/relay/.env.example` to `infra/relay/.env` for local relay deployment settings.
Deploy `prod` before personal stages because it owns the retained database that their branches
depend on. The stack's `PublishClientConfig` action writes `T3CODE_RELAY_URL` and the single-line
`\n`-escaped `T3CODE_CLOUD_MINT_PUBLIC_KEY` back to the root `.env`.

## CLI OAuth application

In Clerk's OAuth applications settings:

1. Create a public OAuth application for the CLI, using authorization-code exchange with PKCE.
2. Allow the redirect URI `http://127.0.0.1:34338/callback`.
3. Enable the `openid`, `profile`, `email`, and `offline_access` scopes.
4. Enable **Device authorization grant** on the application. Headless, SSH, and
   no-hosted-web (`T3CODE_HOSTED_APP_URL` unset) CLI logins use it, and Clerk only advertises
   the device endpoint once it is on. The feature is in beta and Clerk enables it per account
   on request.
5. Set `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` to the generated public client ID in local and release
   build environments.

## JWT template

Create a Clerk JWT template named `t3-relay` with claims:

```json
{ "aud": "t3-code-relay" }
```

Set `T3CODE_CLERK_JWT_TEMPLATE=t3-relay` for clients and
`CLERK_JWT_AUDIENCE=t3-code-relay` for the relay. The audience stays the same across relay stages;
the relay URL selects the deployment.

## Desktop OAuth redirects

Enable Clerk's Native API and add the fork's desktop renderer redirects to its SSO redirect
allowlist (see `apps/desktop/src/electron/ElectronProtocol.ts` and
`packages/shared/src/channelIdentity.ts`):

```text
shuv2code-dev://app/
shuv2code-nightly://app/
shuv2code-preview://app/
shuv2code://app/
s2code-dev://app/
s2code-nightly://app/
s2code-preview://app/
s2code://app/
```

Add the corresponding origins (without trailing slash: `shuv2code-dev://app`,
`shuv2code-nightly://app`, `shuv2code-preview://app`, `shuv2code://app`, plus the `s2code-*://app`
aliases) to the Clerk instance's Backend API `allowed_origins` array. Update the array with
`PATCH https://api.clerk.com/v1/instance` using the Clerk secret key, preserving existing entries.
The Clerk Electron integration handles token persistence and system-browser callback delivery.

## Android native sign-in redirects

Clerk's native Android SDK uses `clerk://<applicationId>.callback`. In the Clerk instance selected
by the app's publishable key, add each supported fork package to **Native applications > Allowlist
for mobile SSO redirect** (see `scripts/lib/mobile-release-identity.ts`):

| Variant         | Callback                                      |
| --------------- | --------------------------------------------- |
| Development     | `clerk://dev.shuv.shuv2code.dev.callback`     |
| Nightly/Preview | `clerk://dev.shuv.shuv2code.nightly.callback` |
| Production      | `clerk://dev.shuv.shuv2code.callback`         |

Preserve existing entries. These callbacks are separate from the `s2code-*` / `shuv2code-*`
navigation schemes. A private development build using the production Clerk key still needs its
development callback allowed by that instance's administrator; rebuilding the same package does
not change the allowlist.

## Desktop passkeys

macOS passkeys are optional: signed macOS builds with `T3CODE_CLERK_PUBLISHABLE_KEY` succeed
without a provisioning profile and opt into Associated Domains passkeys only when
`T3CODE_MACOS_PROVISIONING_PROFILE` or `T3CODE_CLERK_PASSKEY_RP_DOMAINS` is set.

For a signed macOS app using the fork's bundle ID (`dev.shuv.shuv2code.nightly` for Nightly,
`dev.shuv.shuv2code.preview` for Preview, or `dev.shuv.shuv2code` for Stable):

1. Create an explicit macOS App ID in the Apple Developer portal with **Associated Domains**.
2. Create a provisioning profile for that App ID and the distribution signing certificate.
3. In Clerk's Native API settings, add an iOS app with the same Apple Team ID and bundle ID.
   This setting also configures Electron/macOS passkeys.
4. Check `https://<frontend-api>/.well-known/apple-app-site-association`. Its
   `webcredentials.apps` must include `<TEAM_ID>.dev.shuv.shuv2code.nightly` (or the matching
   channel bundle ID).
5. Configure fork signing using the prerequisites in the [release runbook](./release.md#account-and-credential-prerequisites-names-only).

Local signed passkey builds additionally use:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/s2code.provisionprofile
# Override only when the RP domain differs from the Clerk Frontend API hostname.
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.<your-domain>
```

Without the override, the build derives the RP domain from the Clerk publishable key.
After changing Associated Domains, bump the build version before rebuilding. macOS can otherwise
reuse stale Shared Web Credentials metadata for the same app/version pair.

The ordinary `dev:desktop` launcher is unsigned and cannot exercise macOS passkeys. For renderer
HMR, install a signed build, start `vp run dev:web`, and launch the installed executable with the
actual web and server ports. For example, with the default ports:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3CODE_PORT=13773 \
  "/Applications/S2Code (Nightly).app/Contents/MacOS/S2Code (Nightly)"
```

Rebuild the signed app after native dependency, main-process, preload, entitlement, provisioning,
or signing changes. Renderer edits can reuse it. Verify the installed bundle before testing:

```sh
codesign --verify --deep --strict "/Applications/S2Code (Nightly).app"
codesign -d --entitlements :- "/Applications/S2Code (Nightly).app"
```

## Restricting sign-ups

Use Clerk's allowlist for permitted email addresses or domains, or Restricted mode for invitation-only
sign-up. An enabled empty allowlist blocks all new sign-ups.

Sign-up restrictions do not revoke an existing account's access. Ban the account in Clerk when
its active sessions and future sign-ins must be disabled.
