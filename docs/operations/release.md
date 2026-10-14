# Fork releases

The canonical pipeline is `.github/workflows/release.yml`, restricted to
`shuv1337/shuv2code`. It replaces the artifact-only `fork-desktop.yml` workflow.
Do not use an upstream release, npm scope, signing identity or deployment as a substitute.

## Matrix and source

One resolved commit and one exact version feed the shared JS bundle, all native
builds, archives, package manifests and release receipts. Desktop builds cover
macOS ARM64/x64 (DMG and ZIP), Linux ARM64/x64 (AppImage and DEB), and Windows
ARM64/x64 (NSIS). Each Windows desktop embeds the matching same-version Linux
archive; its packaged digest is checked before publication.

CLI archives cover **five** targets: `darwin-arm64`, `linux-arm64`, `linux-x64`,
`win32-arm64`, `win32-x64`. **Intel macOS CLI/SEA is unsupported**; use the Intel
desktop app. Internal executable/archive names remain `t3`; that does not authorize
publishing the workspace package named `t3`, which is private.

Public npm endpoints are `shuv2code` and `@shuv2code/t3-<platform>` for those five
CLI targets. Platform packages publish and verify first; the launcher follows only
when all five are verifiable, with exact matching optional dependency versions.

## Channel and publication policy

Stable tag pushes and manual stable dispatches require complete macOS and Windows
signing configuration. Nightly schedules also require signing. Only a manual
nightly/preview dispatch with `allow_unsigned` explicitly enabled may omit signing;
the release title/body and `release.json` identify unsigned builds. Partial credentials
are not proof of signing. Signed jobs verify platform signatures; macOS verifies
notarization and the configured team.

Artifacts are first uploaded to a **draft** release and checked against their
GitHub SHA-256 digests. All six npm packages use a temporary, non-default release
dist-tag with `npm publish --provenance`. Registry names, versions, repository and
tarball integrity are verified before exposure. Updater manifests are uploaded
last; the complete draft is verified before publication. Dist-tags are then
promoted, platform packages first and launcher last: `latest` for stable,
`nightly` for nightly, `preview` for preview. Preview never carries updater
manifests/blockmaps and never enters the automatic release index.

`SHA256SUMS` covers final desktop and CLI bytes. Stable/nightly feeds use their
channel-specific Electron manifest names, including both architectures. The
rolling `index.json` on the dedicated `fork-release-index` branch is written last, using
`[{"tag_name":"v1.2.3","draft":false}]` records for complete non-preview releases.
The Contents API publishes a commit with the previous blob SHA as a compare-and-swap;
there is no delete-before-upload window. A failed update leaves the last index available.
The stable URL is
`https://raw.githubusercontent.com/shuv1337/shuv2code/fork-release-index/index.json`.
This is compatible with the server-only `SHUV2CODE_RELEASE_INDEX_URL`; mirrors
may copy this index to their archive base's `index.json`. The normal fork server
uses GitHub's release API, which omits drafts.
No reader default changes are required. If explicitly configuring the rolling
index, use the raw branch URL above, not the former release-asset URL. CDN caches
may briefly serve the previous complete index after a successful publication.

GitHub and npm cannot commit a release atomically. Exact npm versions become
public during publication, but automatic tags remain unchanged until verification.
A failed platform publish skips the launcher; a later failure leaves automatic
promotion incomplete and the workflow red. Never treat a successful dry run or
one published endpoint as delivery evidence.

## Account and credential prerequisites (names only)

Use the protected GitHub environment `fork-release`, with appropriate default
branch/tag protections and approvals. Repository variables:
`FORK_NPM_TRUSTED_PUBLISHING_READY`, `APPLE_TEAM_ID`.

macOS secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

Windows secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`,
`AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.

Only if hosted macOS passkeys are explicitly enabled: `MACOS_PROVISIONING_PROFILE`,
`CLERK_PASSKEY_RP_DOMAINS` and the fork Clerk inputs. Local/direct signed releases
do not require Clerk, relay, passkey domains or a hosted provisioning profile.
Hosted/relay, marketing and AUR deployment are intentionally separate and are not
invoked by this pipeline; configure their fork identities in their owning work.

Human npm setup must establish ownership/bootstrap of all six package names and
trusted publishers for **calling workflow filename `release.yml`**, repository
`shuv1337/shuv2code`, environment `fork-release`. Enable both direct `npm publish`
and `npm dist-tag` allowed actions for each package. The readiness variable is an
explicit human attestation, not an authentication test. `npm whoami`, token names,
404 responses and `npm publish --dry-run` do not verify trusted-publisher readiness.
New trusted-publisher configurations have a short initial-validation window; see
the current [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers).
The publisher uses a GitHub-hosted runner, `id-token: write`, npm 11.21.0 and no
`NPM_TOKEN`/`NODE_AUTH_TOKEN` fallback. No credentials belong in source or release assets.

## Recovery and human smoke evidence

Rerun failed jobs using the **original immutable `fork-release-prepared` artifact**.
Already uploaded assets and npm versions are reused only when their digests match.
Do not rebuild different signed bytes under an immutable version, overwrite public
release assets or move a dist-tag backwards. If the original prepared bytes are
lost, use a new version. Rolling index/tag repair may be retried after a fully
verified release; inspect all six endpoints and the release before doing so.

Before claiming delivery, a human must run the protected workflow with real fork
accounts and capture: signature/team/publisher and notarization evidence; CLI
smoke results on all five architectures; installs/upgrades for each desktop target;
same-arch Windows WSL startup; clean npm installs of the launcher and optional
packages; OIDC provenance; checksums and stable/nightly feed selection; preview
absence from automatic feeds; install-order coexistence with upstream. An offline
test or green artifact job is not evidence that signing, npm ownership or delivery
was configured correctly.
