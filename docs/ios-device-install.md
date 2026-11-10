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

export APP_VARIANT=preview APPLE_TEAM_ID=7H54B326YZ
cd apps/mobile
CI=1 EXPO_NO_GIT_STATUS=1 vp exec expo prebuild --clean --platform ios
```

For a shell-created worktree, `vp i` performs the initial setup. If another tool
already started setup (`.t3/setup-running` contains a live PID), wait for it rather
than installing concurrently. Do not copy another worktree's generated `ios/`,
Pods, or `node_modules`: dependency patches can change their absolute paths.

No hosted Expo account, EAS build, live server state, or root `.env` copy is needed
for direct server connections. Hosted auth, push, and OTA remain disabled unless
explicitly configured; see [mobile release configuration](operations/mobile-release.md).

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
