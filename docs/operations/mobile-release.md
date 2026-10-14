# Fork mobile release configuration

Mobile release jobs fail without fork configuration. PR previews without `EXPO_TOKEN` explicitly report a dry run, not delivery. Local/direct connections require no Expo or hosted account. Never reuse upstream destinations or signing credentials.

## GitHub configuration (names only)

Variables: `EXPO_OWNER`, `EXPO_PROJECT_ID`, `APPLE_TEAM_ID`, `ASC_APP_ID`, `GOOGLE_PLAY_PROJECT_ID`, `GOOGLE_PLAY_TRACK`, `GOOGLE_PLAY_PREVIEW_TRACK`, `GOOGLE_PLAY_SIGNING_CERT_SHA256`.

Secrets: `EXPO_TOKEN`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_PRIVATE_KEY`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.

Opt-in variables: `MOBILE_UPDATES_ENABLED`, `MOBILE_PUSH_ENABLED`, `MOBILE_AUTH_ENABLED`. All default off. For enabled hosted auth: variables `MOBILE_AUTH_DOMAIN`, `MOBILE_RELAY_URL`; fork EAS environment `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CLERK_JWT_TEMPLATE`, and any enabled `EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME`. Known upstream hosted domains are rejected, including during ordinary Expo config evaluation. Domain associations and relay deployment coordinate with #276; they are not prerequisites for direct mobile.

For enabled push: variables `APNS_TEAM_ID`, `FIREBASE_PROJECT_ID`; secrets `APNS_KEY_ID`, `ANDROID_GOOGLE_SERVICES_JSON`; fork EAS file environment `ANDROID_GOOGLE_SERVICES_FILE`. The downloaded file and Firebase Android client must match the selected variant. Keep the GitHub JSON secret and EAS file contents identical so CI and build workers compute the same native fingerprint. Provision APNs private keys and FCM sending credentials in the fork relay separately; do not expose them in app configuration.

Optional version-override secrets: `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`.

## Accounts and human delivery proof

Create a fork Expo account/project with slug `shuv2code`; authorize the token and production/preview environments. Register paid Apple Developer App IDs and provisioning/signing credentials for `dev.shuv.shuv2code` (production), `.nightly` (preview), and `.dev` (development), including derived `.widgets`, `.share`, `.watchkitapp` and `group.<bundle-id>` identities. Register the production App Store Connect app and a scoped submission API key. Confirm EAS-managed certificates/profiles belong to the configured Apple team, not upstream. Configure the fork's associated domains and OAuth/native sign-in registrations only for enabled auth.

Create a Google Play application `dev.shuv.shuv2code`, its configured release/testing tracks, and a project-scoped service account with access to that package. Provision a fork upload keystore through EAS and Play App Signing. Set the mirror certificate digest from the **Play app-signing certificate**, not the upload key. Register variant packages in fork Firebase when push is enabled. Establish APNs team/key and FCM relay credentials for enabled remote notifications.

CI verifies Expo owner/project/slug before its first environment pull and rechecks resolved native identities before remote work. It verifies ASC bundle/application and Play package/track access before submission; it verifies downloaded APK package and certificate before attachment. External ownership, EAS signing credential provenance and device delivery still need human proof: install iOS/TestFlight plus Watch, Play-track Android and mirrored APK; check signing/team/certificate identities; exercise local/direct server compatibility, optional auth/push/deep links and OTA on matching and mismatched runtimes. A scheduled build or submission is not an installed release.

Mobile/server compatibility uses the shared orchestration protocol version, not equal desktop/mobile semver. Release and OTA profiles retain native fingerprint runtime policy, including mobile-major isolation in `apps/mobile/fingerprint.config.js`; OTA is opt-in and scoped to the verified fork project. Do not bump mobile versions merely to match desktop.

With OTA disabled, native/version changes still schedule binary releases on push. If reconciliation schedules no replacement binary, the workflow fails rather than claiming JS-only changes reached users. Run **Mobile EAS Production** on that commit with `mode=build`, `profile=production` and the indicated `platform` (or `all`) to ship the replacement binary. An in-flight build for an older commit is not proof that the current JS changes shipped.

For manual release invocation, run `node scripts/mobile-release-preflight.ts project` before `eas env:pull`, then `node scripts/mobile-release-preflight.ts prepare` before build/auto-submit. Use matching `--mode`, `--profile`, `--platform`; preparation writes ephemeral submission configuration/credential paths. CI cleans credentials afterward. Do not commit generated `eas.json`, credentials or Google services files.
