# Install S2Code on a paired iPhone

Use a local **Release** build for a self-contained app that does not need Metro.
These steps update the existing **S2Code Nightly** installation on `shuvphone`
(`dev.shuv.shuv2code.nightly`), preserving its data. The separate production
`S2Code` app is not replaced.

## Prerequisites

On shuvbot, use Xcode 27.2 beta 2, Vite Plus (`vp`), CocoaPods, and the existing
Apple Development identity for team `7H54B326YZ`. The paired iPhone must have
Developer Mode enabled and be reachable by USB or Wi-Fi. Unlock it if installation
or launch requests it.

```bash
export DEVELOPER_DIR=/Applications/Xcode-27.2.0-Beta.2.app/Contents/Developer
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
xcodebuild -version
security find-identity -v -p codesigning
xcrun devicectl list devices
```

The UTF-8 locale is required by CocoaPods in noninteractive shells. Without it,
Ruby can fail with `Unicode Normalization not appropriate for ASCII-8BIT`.

Reuse the installed profiles and private keys. Do not add
`-allowProvisioningUpdates` or create certificates/App IDs just to make a build
pass. A missing/expired profile or an Apple account agreement may require the
account owner's action in Xcode first. Do not switch to a Personal Team or change
the bundle ID: that would create a different installation and omit capabilities.

`vp env current` must show pnpm 12.14.0 in managed mode; if it shows `system_first`,
run `vp env on pnpm` once, or `vp i` installs with a global pnpm that skips the patches.

## Fresh checkout and native project

Choose a new worktree/build-directory name for each source revision. Run in Bash:

```bash
set -euo pipefail
REPO="$HOME/repos/s2code"
STAMP=$(TZ=America/Los_Angeles date +%Y%m%d-%H%M%S)
WORKTREE="$HOME/.shuv2code-v2-nightly/worktrees/s2code/ios-shuvphone-$STAMP"
DERIVED="$HOME/.shuv2code-v2-nightly/caches/ios-shuvphone-$STAMP"
DEVICE=00008150-001574C2026A401C

# Fetch only; leave the main checkout and running server untouched.
git -C "$REPO" fetch origin main
git -C "$REPO" worktree add --detach "$WORKTREE" origin/main
cd "$WORKTREE"
git rev-parse HEAD
git rev-list --count HEAD
vp i

cat > "$WORKTREE/.env.local" <<EOF
MOBILE_AUTH_ENABLED=1
MOBILE_RELAY_URL=$(gh variable get T3CODE_RELAY_URL --repo shuv1337/s2code)
EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=$(gh variable get T3CODE_CLERK_PUBLISHABLE_KEY --repo shuv1337/s2code)
EXPO_PUBLIC_CLERK_JWT_TEMPLATE=$(gh variable get T3CODE_CLERK_JWT_TEMPLATE --repo shuv1337/s2code)
EOF

export APP_VARIANT=preview APPLE_TEAM_ID=7H54B326YZ
cd apps/mobile
CI=1 EXPO_NO_GIT_STATUS=1 vp exec expo prebuild --clean --platform ios
! grep -E 'applesignin|aps-environment' ios/S2CodeNightly/S2CodeNightly.entitlements
```

`loadRepoEnv` reads `$WORKTREE/.env.local` in both `expo prebuild` and `xcodebuild`, so
Xcode's JavaScript bundling phase sees the same S2 Connect settings even when shell
environment variables are dropped (explicit process environment variables override `.env.local`).

For a shell-created worktree, `vp i` performs the initial setup. If another tool
already started setup (`.t3/setup-running` contains a live PID), wait for it rather
than installing concurrently. Do not copy another worktree's generated `ios/`,
Pods, or `node_modules`: dependency patches can change their absolute paths.

S2 Connect is enabled via the four public values in `.env.local` above while push
(`MOBILE_PUSH_ENABLED`), OTA (`MOBILE_UPDATES_ENABLED`), `MOBILE_AUTH_DOMAIN`,
`MOBILE_APPLE_SIGN_IN_ENABLED`, `MOBILE_RELEASE_INTENT`, and `EXPO_PROJECT_ID` stay
off so the existing `7H54B326YZ` signing profiles remain untouched. No hosted Expo
account, EAS build, or live server state is needed; see
[mobile release configuration](operations/mobile-release.md).

## Build, install, and verify

Keep `APP_VARIANT=preview` and the signing team exported during both prebuild and
Xcode's JavaScript bundling phase:

```bash
xcodebuild \
  -workspace ios/S2CodeNightly.xcworkspace \
  -scheme S2CodeNightly \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  build > "$DERIVED.build.log" 2>&1

APP="$DERIVED/Build/Products/Release-iphoneos/S2CodeNightly.app"
/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP/Info.plist"
/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Info.plist"
/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$APP/Info.plist"
codesign --verify --deep --strict "$APP"
test -s "$APP/main.jsbundle"
node -e '
  const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (!cfg.extra?.relay?.url || !cfg.extra?.clerk?.publishableKey || !cfg.extra?.clerk?.jwtTemplate || cfg.extra?.pushEnabled !== false) {
    throw new Error("Unexpected embedded app.config: " + JSON.stringify(cfg.extra));
  }
' "$APP/EXConstants.bundle/app.config"
/usr/libexec/PlistBuddy -c 'Print CFBundleURLTypes' "$APP/Info.plist" | grep -q 'dev.shuv.shuv2code.nightly'
# Compare signed entitlements against the previous build (PREV_APP) to verify no unexpected capabilities were added.
codesign -d --entitlements :- "$APP" 2>/dev/null | diff -u <(codesign -d --entitlements :- "$PREV_APP" 2>/dev/null) -

xcrun devicectl device install app --device "$DEVICE" "$APP"
xcrun devicectl device info apps --device "$DEVICE" \
  --filter 'bundleIdentifier == "dev.shuv.shuv2code.nightly"'
xcrun devicectl device process launch --device "$DEVICE" \
  --terminate-existing dev.shuv.shuv2code.nightly
xcrun devicectl device info processes --device "$DEVICE" \
  --search S2CodeNightly
```

Require `BUILD SUCCEEDED`, a successful device install, matching on-device version
and build number, and a successful launch with a live process. Local build numbers
come from `git rev-list --count HEAD`; the marketing version comes from
`apps/mobile/app.config.ts` (unless deliberately overridden with
`T3CODE_MOBILE_VERSION`). Desktop/package versions are unrelated. Record the SHA
alongside the version because the commit count is not a unique revision ID.

If the phone is unavailable, unlock it on the same Wi-Fi or connect USB and accept
any trust prompt, then rerun device discovery. If launch is blocked by the lock
screen, the install may still have succeeded; verify it before retrying launch.
Do not uninstall the app to fix reachability or signing: that removes local data.

For the separate production installation, use `APP_VARIANT=production`, workspace
`ios/S2Code.xcworkspace`, scheme/product `S2Code`, and bundle ID
`dev.shuv.shuv2code` throughout. Prebuild again after changing variants.

## Share an install link with Sqim

`sqim upload --device --build` archives and exports on its own, which fails for this
project because of the T3Watch watch target. Build with the `xcodebuild` command above.

A plain `zip -qry S2CodeNightly.ipa Payload` can put the embedded
`Watch/T3Watch.app/Info.plist` before `Payload/S2CodeNightly.app/Info.plist`.
Sqim v0.2.4 then writes `dev.shuv.shuv2code.nightly.watchkitapp` as the
`bundle-identifier` in `manifest.plist`. iOS tries to install a separate
placeholder app and reports “Unable to Install”. Add the main app’s plist and
provisioning profile first. `-y` preserves symlinks without changing the signed `.app`:

```bash
IPA_DIR=$(mktemp -d)
mkdir -p "$IPA_DIR/Payload"
cp -R "$APP" "$IPA_DIR/Payload/"
(
  cd "$IPA_DIR" &&
    zip -qy S2CodeNightly.ipa \
      Payload/S2CodeNightly.app/Info.plist \
      Payload/S2CodeNightly.app/embedded.mobileprovision &&
    zip -qry S2CodeNightly.ipa Payload
)
sqim upload --device --ipa "$IPA_DIR/S2CodeNightly.ipa"
```

After the upload exits 0, set `SQIM_URL` to the printed HTTPS install link
(`https://build.sqim.dev/sqim/install/<token>`). Share it only if this check passes:

```bash
(
  manifest=$(curl -fsSL "$SQIM_URL/manifest.plist") &&
    grep -Fq '<string>dev.shuv.shuv2code.nightly</string>' <<< "$manifest" &&
    ! grep -Fq '.watchkitapp' <<< "$manifest"
)
```

Signing needs a macOS desktop (Aqua) session: over plain SSH, codesign fails with
`errSecInternalComponent` or "User interaction is not allowed".
