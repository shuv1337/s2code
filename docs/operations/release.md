# Fork releases

The canonical pipeline is `.github/workflows/release.yml`, restricted to
`shuv1337/s2code`. It replaces the artifact-only `fork-desktop.yml` workflow.
Do not use an upstream release, npm scope, signing identity or deployment as a substitute.

The repository was renamed from `shuv1337/shuv2code`. Installed builds still carry
the old name in their updater feed and installer URLs and rely on GitHub's rename
redirect, so never create a new repository named `shuv2code`. npm trusted publishers
bind to the repository name and must name `shuv1337/s2code`. An available npm name
does not prove ownership. npm rejects the bare `s2code` name as too similar to existing
packages, so the one npm package is `shuv2code`, which installs the `shuv2code`, `s2code`
and `s2c` commands. Keep its trusted publisher configured. Do not
move the maintainer checkout while project paths and attached worktrees use it.
Signed desktop app IDs, Electron renderer origins, profile directories and the
internal Electron package name retain their installed identities. Electron selects
the Keychain/libsecret key from that package name before asynchronous startup;
changing it strands encrypted connections even when the profile path stays the same.
Public app names and URL schemes use S2Code and `s2code`.

## Matrix and source

One resolved commit and one exact version feed the shared JS bundle, all native
builds, archives and package manifests. Desktop builds cover
macOS ARM64 (DMG and ZIP), Linux ARM64/x64 (AppImage and DEB), and Windows
x64 (NSIS). Intel macOS and Windows ARM64 are not built. The Windows desktop embeds the matching same-version Linux
`s2code-<version>-linux-<arch>` archive for its WSL backend.

A failed Windows x64 build does not block the release. Publication leaves out the
Windows installer and CLI archive, does not publish npm for that version (the launcher
pins a checksum for every platform's archive, Windows included), keeps the release out of the
rolling index, and says so in the release notes. macOS and Linux still block.

CLI archives cover **four** targets: `darwin-arm64`, `linux-arm64`, `linux-x64`,
`win32-x64`. CLI release archives are named `s2code-<version>-<platform>-<arch>` and
include byte-identical `shuv2code-<version>-<platform>-<arch>` and
`t3-<version>-<platform>-<arch>` aliases for installed clients; all three names have
checksum entries. The archive's internal root directory retains
`shuv2code-<version>-<platform>-<arch>` because existing PowerShell installers
look for that exact directory. The internal executable remains `t3`. That does not authorize
publishing the workspace package named `t3`, which is private.

When npm is enabled, the only public npm endpoint is `shuv2code`, built by
`scripts/build-npm-launcher.ts` on upstream's single-launcher model. It holds no native
code: `checksums.json` pins the SHA-256 of each of the four CLI archives, and on first run
`bin/shuv2code.mjs` downloads its platform's archive from this version's GitHub Release,
refuses it on a mismatch, validates `t3 --version`, and caches it under the OS cache
directory (`<cache>/s2code/runtime/<version>`). Any other platform gets a "not supported"
error. `S2CODE_RELEASE_BASE_URL` points it at a mirror; the pinned checksums still apply.
`T3CODE_NPM_LAUNCHER_PATH` tells the executable which launcher started it, so service
units and update suggestions name the global `shuv2code` command, not the cached binary.

## Retired npm packages (one-time owner step)

`@s2code/cli` and `@s2code/t3-<platform>` (`darwin-arm64`, `linux-arm64`, `linux-x64`,
`win32-x64`, `win32-arm64`) are retired. CI never publishes them again, so
`0.1.6-nightly.20261104.89` is the final release of each `@s2code/t3-*` package. Nothing
is unpublished. The workflow does not deprecate them: npm trusted publishing covers
`npm publish` from `release.yml`, not `npm deprecate`, and this runs once. After the first
launcher release is public and `npm i -g shuv2code` works from it, an owner logged in to
npm publishes a final `@s2code/cli` and deprecates every retired package.

The final `@s2code/cli` is a thin alias. Its version is the first launcher release, so it
becomes `@s2code/cli@latest`. Its `package.json`:

```json
{
  "name": "@s2code/cli",
  "version": "<first launcher version>",
  "description": "Replaced by shuv2code. Installs and runs it.",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/shuv1337/s2code" },
  "bin": { "s2code": "./bin/s2code.mjs" },
  "dependencies": { "shuv2code": "latest" }
}
```

and its `bin/s2code.mjs`:

```js
#!/usr/bin/env node
import "shuv2code/bin/shuv2code.mjs";
```

Publish it from that directory, then deprecate:

```bash
npm publish --access public --tag latest
npm dist-tag add "@s2code/cli@<first launcher version>" nightly
for name in @s2code/cli @s2code/t3-darwin-arm64 @s2code/t3-linux-arm64 \
  @s2code/t3-linux-x64 @s2code/t3-win32-x64 @s2code/t3-win32-arm64; do
  npm deprecate "$name" 'Replaced by shuv2code (single launcher); run npm i -g shuv2code'
done
```

`npx @s2code/cli` then prints the deprecation and still runs the newest `shuv2code`.
Upgrading an existing `shuv2code` install needs nothing: `npm i -g shuv2code` replaces
`0.1.6-nightly.20261104.89`, npm drops its `@s2code/t3-*` optional dependencies, and the
same three commands stay on `PATH`.

## macOS arm64 runner

The macOS arm64 desktop build runs first on `shuvbot-macos`, a self-hosted Apple Silicon
runner (labels `self-hosted, macOS, ARM64, shuvbot-macos`) that Fleet Ops owns. Ask Fleet Ops about
its availability, Xcode installs and maintenance. If shuvbot has not picked the build up within
10 minutes, a hosted `macos-26` build starts and cancels the queued one (they share a concurrency
group). Nothing retries a hosted build that never gets a runner.
The job pins Xcode 27.1 through `DEVELOPER_DIR` and fails on a beta, because the runner's
default Xcode is a beta. It runs only for `schedule` or `workflow_dispatch` on `main` (an
allowlist, so `pull_request` and every other event are refused). The macOS job never receives the
Azure Trusted Signing secrets, empties the workspace before checkout, and deletes its signing
keychains, keys and profiles from `RUNNER_TEMP` at the end. npm publishing stays on GitHub-hosted
runners: `scripts/fork-release.ts` refuses any other runner.

To go back to hosted runners, change `FORK_MACOS_ARM64_SELF_HOSTED_RUNNER` in
`scripts/lib/fork-release.ts` to `"macos-26"`.

## Nightly only

The fork publishes only nightly releases, using the red production artwork.
`release.yml` runs once a day and
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
signed. A platform without complete credentials ships unsigned.
Release titles identify the version and channel; the body describes signing
separately under macOS and Windows, including warnings and updater limitations
for unsigned platforms. `release.json` retains the per-platform signing policy
and aggregate unsigned flag. Partial credentials are not proof of signing.

An unsigned macOS or Windows build publishes no updater feed, because those
updaters require a signature, and the release is then left out of the rolling
index. Linux updates are checksum-only, so their feeds always publish.

Publication accepts only the default branch. The scheduled due/source check
runs without a protected environment, so days with nothing to release skip the
builds and publication without requesting approval.

Artifacts are first uploaded to a **draft** release and checked against their
GitHub SHA-256 digests. Updater manifests are uploaded last, and the complete
draft is verified before publication.

npm publication is optional. It requires `FORK_NPM_TRUSTED_PUBLISHING_READY` to be
`true`. Otherwise the GitHub release still publishes and `release.json` lists no npm
packages. When it is, the publish job builds the launcher from the release's CLI archives
and checks that its `checksums.json` matches the archives being uploaded. The launcher
publishes under a temporary non-default dist-tag with `npm publish --provenance` while the
release is still a draft; nobody installs that tag, so it does not matter that its download
would fail until then. Its name, version, repository and tarball integrity are verified
before the release is exposed. npm reviews each new version before it can be installed,
which took up to about fifteen minutes; the review is awaited for up to thirty minutes.
Answers the registry could not give (429, 5xx, timeouts) are retried within that budget;
a mismatched tarball or a package outside the allowlist fails at once.
The `nightly` dist-tag is promoted only after the release publishes, so a promoted launcher
can always download its archive. A nightly moves `latest` as well, so `npx shuv2code`
installs the newest nightly; `nightly` refuses to move backwards, while `latest` is left
alone with a log line when a newer version already holds it.

`SHA256SUMS` covers final desktop and CLI bytes. The updater feeds that publish
use the `nightly*.yml` Electron manifest names and include both architectures. The
desktop assets in those feeds are named `S2Code-<version>-<arch>.<ext>`.
rolling `index.json` on the dedicated `fork-release-index` branch is written last, using
`[{"tag_name":"v1.2.3-nightly.20261014.1","draft":false}]` records for complete releases.
The Contents API publishes a commit with the previous blob SHA as a compare-and-swap;
there is no delete-before-upload window. A failed update leaves the last index available.
The index URL is
`https://raw.githubusercontent.com/shuv1337/s2code/fork-release-index/index.json`.
This index is available to mirrors or other consumers; publishing it does not
add a runtime discovery protocol or mirror configuration. Current client update
checks retain the fork npm/GitHub sources. Consumers of the rolling index should
use the raw branch URL above, not the former release-asset URL. CDN caches may
briefly serve the previous complete index after a successful publication.

When npm is enabled, GitHub and npm cannot commit a release atomically. Exact npm
versions become public during publication, but automatic tags remain unchanged until verification.
A failure after the launcher publishes leaves automatic promotion incomplete and the workflow red. Never treat a successful dry run or
one published endpoint as delivery evidence.

## Account and credential prerequisites (names only)

Use the protected GitHub environment `fork-release`, with appropriate default
branch protections and approvals. Repository variables:
`FORK_NPM_TRUSTED_PUBLISHING_READY`, `APPLE_TEAM_ID`. `S2CODE_NPM_TRUSTED_PUBLISHING_READY`
attested the retired `@s2code/*` publishers and is no longer read.

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

npm is optional (see [Nightly only](#nightly-only)). To enable it, the `shuv2code`
package needs a trusted publisher
for **calling workflow filename `release.yml`**, repository `shuv1337/s2code`, environment `fork-release`. Enable both direct `npm publish`
and `npm dist-tag` allowed actions. The readiness variable is an
explicit human attestation, not an authentication test. `npm whoami`, token names,
404 responses and `npm publish --dry-run` do not verify trusted-publisher readiness.
New trusted-publisher configurations have a short initial-validation window; see
the current [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers).
The publisher uses a GitHub-hosted runner, `id-token: write`, npm 11.21.0 and no
`NPM_TOKEN`/`NODE_AUTH_TOKEN` fallback. No credentials belong in source or release assets.

## Recovery and human smoke evidence

Use **Re-run failed jobs** on the same workflow run, never **Re-run all jobs**, which
rebuilds the signed desktops as different bytes. The `publish` job prepares again from
that run's immutable build artifacts, and the npm tarballs are byte-reproducible for
the same archives and the Node version `package.json` pins, so the rebuilt bytes
match any npm versions an earlier attempt already published.
Already uploaded assets and npm versions are reused only when their digests match.
Do not rebuild different signed bytes under an immutable version, overwrite public
release assets or move a dist-tag backwards. If the run's build artifacts have
expired or the builds must be redone, use a new version. Rolling index/tag repair may be retried after a fully
verified release; inspect the npm package and the release before doing so.

Before claiming delivery, a human must run the protected workflow with real fork
accounts and capture: signature/team/publisher and notarization evidence for
signed platforms; CLI smoke results on all four architectures; installs/upgrades
for each desktop target; same-arch Windows WSL startup; checksums and nightly feed
selection; install-order coexistence with upstream. With npm enabled, also capture
a clean `npm i -g shuv2code`, its first-run download on each platform, and OIDC provenance. An
offline test or green artifact job is not evidence that signing, npm ownership or delivery
was configured correctly.
