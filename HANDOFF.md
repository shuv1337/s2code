# shuv2code iOS Sqim Release Handoff

Updated: 2026-08-17 00:51 PDT

## Goal

Finish a development-signed Sqim iPhone build for `shuv2code@0.1.1-alpha.2` on shuvbot, verify the install link, then use that successful matching iOS build as the prerequisite for the public `next` release workflow.

## Environment

- Work locally on shuvbot in `/Users/shuv/repos/shuv2code`.
- The checkout is colocated with Jujutsu. Use `jj`, not routine Git commands.
- `main` is at `a43fc50e1caeb1a3c17c1e3f3019935a17e23532`.
- Dependencies were refreshed successfully with `pnpm install --frozen-lockfile`.
- Sqim is authenticated with the intended organizational account. Verify with `sqim status --json`, but do not print or copy credentials.
- The iOS workspace is `apps/mobile/ios/shuv2code.xcworkspace`; the scheme is `shuv2code`.
- Apple development team ID: `7H54B326YZ`.

## Preserve Existing Work

The shuvbot working copy contains pre-existing mobile branding changes. Do not reset, discard, overwrite, or commit them without explicit user direction. Current paths are visible with `jj status` and include mobile branding components/config, the production app icon, lockfile, and brand-check scripts.

The checkout was previously 370 commits behind. Those changes were rebased onto current `main`. One conflict in `apps/mobile/src/features/home/HomeHeader.tsx` was resolved by retaining upstream `WorkspaceConnectionTitle` behavior while using the local canonical `Shuv2CodeMark` and `shuv2code` product name.

## Current Failure

The Sqim archive reaches the share extension signing step and fails:

```text
CodeSign .../expo-sharing-extension.appex
.../expo-sharing-extension.appex: errSecInternalComponent
Command CodeSign failed with a nonzero exit code
```

Adding the team ID fixed the earlier missing-development-team error. Automatic provisioning now selects a development certificate and creates/selects a provisioning profile for the sharing extension. The failure persists even when the command is run from a visible Herdr terminal, so do not assume this is only an SSH keychain-session problem.

The reported React Core XCFramework `rsync` failure in one earlier run was cancellation fallout from the signing failure, not an independently established root cause.

## Next Actions

1. Load and follow the local Sqim skill at `~/.agents/skills/sqim/SKILL.md`.
2. Use a focused diagnosis workflow before changing project files. Inspect the active code-signing identities, login keychain lock/search-list state, private-key accessibility, certificate validity, and relevant `securityd`/codesign diagnostics.
3. Reproduce signing against the generated extension bundle or with the smallest relevant Xcode archive command if that isolates the Keychain failure faster.
4. Prefer repairing Keychain access or the signing identity over changing bundle IDs, entitlements, or removing the share extension.
5. If macOS presents a private-key access prompt, approve the intended Apple Development identity with the minimum durable access needed for Xcode/codesign.
6. Retry the full upload from `apps/mobile`:

```bash
sqim upload --device . --build \
  --workspace ios/shuv2code.xcworkspace \
  --scheme shuv2code \
  --team-id 7H54B326YZ \
  --allow-provisioning-updates
```

7. Treat only the final successful Sqim output line as the HTTPS install URL. Install/launch it on an iPhone if available and verify the app opens.
8. Send the successful install URL through SHark. A Live Activity may still exist under key `shuv2code-sqim-build`; update/end it rather than creating notification spam.
9. Once the matching iOS build is genuinely confirmed, dispatch `.github/workflows/release.yml` from `main` with `mode=publish`, `channel=next`, and `ios_sqim_release_confirmed=true`. Verify npm installation, Git tag, GitHub release, and release artifacts. Do not set the confirmation before the iOS build succeeds.

## Release Context

- PR: https://github.com/shuv1337/shuv2code/pull/120
- Passing prepare run: https://github.com/shuv1337/shuv2code/actions/runs/31976297755
- Expected gate failure before iOS confirmation: https://github.com/shuv1337/shuv2code/actions/runs/31977913603
- npm package, tag `v0.1.1-alpha.2`, and GitHub release were absent when last checked.
- Release workflow: `.github/workflows/release.yml`
- Canonical package version: `apps/server/package.json`

## Suggested Skills

- `sqim`: required for the device build/upload contract and final install URL.
- `diagnose`: minimize and establish the Keychain/codesign root cause before fixing it.
- `ios-debugger-agent`: useful for focused Xcode inspection or on-device verification on shuvbot.
- `shark`: update the existing Live Activity and send the final install link.
- `clankspace`: required if consequential edits are needed and `.clankspace.json` is present.

## Completion Criteria

- Sqim upload succeeds under the intended account.
- The resulting HTTPS install link works and the iPhone app launches.
- SHark receives the install link.
- Only then is the publish workflow dispatched with the iOS confirmation set to true.
- npm `shuv2code@0.1.1-alpha.2`, Git tag, GitHub release, and artifacts are independently verified.
