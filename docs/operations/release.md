# Fork releases

The canonical pipeline is `.github/workflows/release.yml`, restricted to
`shuv1337/shuv2code`. It replaces the artifact-only `fork-desktop.yml` workflow.
Do not use an upstream release, npm scope, signing identity or deployment as a substitute.

## Matrix and source

One resolved commit and one exact version feed the shared JS bundle, all native
builds, archives, package manifests and release receipts. Desktop builds cover
macOS ARM64/x64 (DMG and ZIP), Linux ARM64/x64 (AppImage and DEB), and Windows
ARM64/x64 (NSIS). Each Windows desktop embeds the matching same-version Linux
`shuv2code-<version>-linux-<arch>` archive; the receipt reads that archive back out of the finished installer and
compares its digest before publication.

CLI archives cover **five** targets: `darwin-arm64`, `linux-arm64`, `linux-x64`,
`win32-arm64`, `win32-x64`. **Intel macOS CLI/SEA is unsupported**; use the Intel
desktop app. CLI release archives are named `shuv2code-<version>-<platform>-<arch>` and
temporarily include byte-identical `t3-<version>-<platform>-<arch>` aliases for installs
from before the rename; both names have checksum entries. The internal executable remains
`t3`. That does not authorize
publishing the workspace package named `t3`, which is private.

When npm is enabled, the public npm endpoints are `shuv2code` and
`@shuv2code/t3-<platform>` for those five CLI targets. Platform packages publish and verify first; the launcher follows only
when all five are verifiable, with exact matching optional dependency versions.

## Nightly only

The fork publishes only nightly releases. `release.yml` runs once a day and
releases `main` when it has new commits and the last nightly is at least six
hours old. A manual **Run workflow** on `main` releases right away. The release
scripts keep upstream's stable and preview code paths so upstream merges stay
clean, but the workflow has no tag trigger or channel input that could start them,
and a version tag is refused as a publication ref.

Each platform is signed when its credentials are complete. Preflight resolves
that once and passes `mac_signed`/`win_signed` to the desktop builds, which fail
closed when a platform planned as signed cannot see its credentials. Every check
runs on the finished artifacts: the app bundle is verified inside the macOS
update ZIP for signature, team and stapled ticket, and the Windows installer for
its publisher. `spctl` is logged but not a gate, because hosted runners report
"Insufficient Context" for a stapled app. The DMG container itself is not
signed, and the Windows receipt needs 7-Zip on the runner to read the
installer's payload. A platform
without complete credentials ships unsigned, and the release title, body and
`release.json` say so. Partial credentials are not proof of signing.

An unsigned macOS or Windows build publishes no updater feed, because those
updaters require a signature, and the release is then left out of the rolling
index. Linux updates are checksum-only, so their feeds always publish.

Publication accepts only the default branch. The scheduled due/source check
runs without a protected environment, so days with nothing to release skip the
builds and publication without requesting approval.

Artifacts are first uploaded to a **draft** release and checked against their
GitHub SHA-256 digests. Updater manifests are uploaded last, and the complete
draft is verified before publication.

npm publication is optional. When `FORK_NPM_TRUSTED_PUBLISHING_READY` is not
`true`, the GitHub release still publishes and `release.json` lists no npm
packages. When it is `true`, all six packages publish under a temporary
non-default dist-tag with `npm publish --provenance`, and their names, versions,
repository and tarball integrity are verified before the release is exposed.
npm reviews each new version before it can be installed, which took up to about
fifteen minutes for these packages; publish waits up to thirty minutes per package.
Answers the registry could not give (429, 5xx, timeouts) are retried within that
budget; a mismatched tarball or a package outside the allowlist fails at once.
After the release publishes, the `nightly` dist-tag is promoted, platform
packages first and the launcher last. A nightly moves `latest` as well, so
`npx shuv2code` installs the newest nightly instead of the placeholder version
that trusted publishing required; `nightly` refuses to move backwards, while
`latest` is left alone with a log line when a newer version already holds it.

`SHA256SUMS` covers final desktop and CLI bytes. The updater feeds that publish
use the `nightly*.yml` Electron manifest names and include both architectures. The
desktop assets in those feeds are named `S2Code-<version>-<arch>.<ext>`.
rolling `index.json` on the dedicated `fork-release-index` branch is written last, using
`[{"tag_name":"v1.2.3-nightly.20261014.1","draft":false}]` records for complete releases.
The Contents API publishes a commit with the previous blob SHA as a compare-and-swap;
there is no delete-before-upload window. A failed update leaves the last index available.
The index URL is
`https://raw.githubusercontent.com/shuv1337/shuv2code/fork-release-index/index.json`.
This index is available to mirrors or other consumers; publishing it does not
add a runtime discovery protocol or mirror configuration. Current client update
checks retain the fork npm/GitHub sources. Consumers of the rolling index should
use the raw branch URL above, not the former release-asset URL. CDN caches may
briefly serve the previous complete index after a successful publication.

When npm is enabled, GitHub and npm cannot commit a release atomically. Exact npm
versions become public during publication, but automatic tags remain unchanged until verification.
A failed platform publish skips the launcher; a later failure leaves automatic
promotion incomplete and the workflow red. Never treat a successful dry run or
one published endpoint as delivery evidence.

## Account and credential prerequisites (names only)

Use the protected GitHub environment `fork-release`, with appropriate default
branch protections and approvals. Repository variables:
`FORK_NPM_TRUSTED_PUBLISHING_READY`, `APPLE_TEAM_ID`.

Signing secrets must be **repository or organization secrets**. The reusable
desktop build does not select `fork-release` and cannot see secrets attached only
to that environment; that environment is used only by the canonical release
preflight and publish jobs. A secret that preflight can read and the build cannot
now fails the build instead of silently producing an unsigned artifact.
`APPLE_TEAM_ID` is a variable rather than a secret, and preflight passes the
value it resolved to the desktop builds, so signing and verification use one team
id even if the variable is defined per environment.

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

npm is optional (see [Nightly only](#nightly-only)). To enable it, human npm setup
must establish ownership/bootstrap of all six package names and trusted publishers
for **calling workflow filename `release.yml`**, repository `shuv1337/shuv2code`, environment `fork-release`. Enable both direct `npm publish`
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
accounts and capture: signature/team/publisher and notarization evidence for
signed platforms; CLI smoke results on all five architectures; installs/upgrades
for each desktop target; same-arch Windows WSL startup; checksums and nightly feed
selection; install-order coexistence with upstream. With npm enabled, also capture
clean npm installs of the launcher and optional packages and OIDC provenance. An
offline test or green artifact job is not evidence that signing, npm ownership or delivery
was configured correctly.
