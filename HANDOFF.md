# HANDOFF — T3 Watch (Apple Watch voice control)

Written 2026-10-10 ~17:30 PDT by Claude (Fable 5.1) orchestrating Astra build agents; updated 2026-10-11 ~16:35 PDT after the live E2E smoke and ~18:30 PDT after Slices A and C landed (built by two Cursor/`claude-opus-5-5` threads launched through T3 orchestration on the owner's live server). Read this, then `docs/rfcs/watch-voice-control.md`, then `AGENTS.md`.

> This file fights `AGENTS.md` ("do not commit plans or agent scratch files"). It is committed because the
> owner asked for a durable handoff. Delete it before anything is proposed upstream.

## Where things are

| Thing                 | Value                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork                  | `git@github.com:shuv1337/shuv2code.git` (`origin`); upstream `pingdotgg/t3code`                                                                                                                            |
| Worktree              | `/Users/shuv/repos/shuv2code-nightly` (a linked worktree of `/Users/shuv/repos/shuv2code`; that main checkout holds the **old, rebranded** fork with uncommitted mobile-branding work — leave it alone)    |
| Base                  | `upstream-nightly` = `fork/nightly` = `4f63275ac` = tag `v0.0.46-nightly.20261010.2948` (published 2026-10-10 14:39 PDT). Pristine upstream; **not** rebranded; package name is still `@t3tools/monorepo`. |
| Work branch           | `feature/watch-server`, pushed, 15 commits ahead of `fork/nightly`, working tree clean                                                                                                                     |
| Tooling               | **Use `./node_modules/.bin/vp`**, not global `vp` — the global one launches an incompatible Vitest 4 here (papercut `pc_28654f08f725`). Deps are installed.                                                |
| Plan/review artifacts | Outside the tree: `/private/var/folders/22/x85ftt9s769dkyr6b_37ys4c0000gn/T/shuvcode/t3-watch-{review-and-plan,brief}.md`                                                                                  |

Upstream has **no `nightly` branch**; nightlies are tags cut from `main`. To rebase onto a newer nightly: `git fetch upstream --tags`, fast-forward `upstream-nightly` to the new tag, rebase `feature/watch-server`. As of 2026-10-11 the newest is `v0.0.46-nightly.20261011.2994` (three nightlies past our base); the owner has not asked to move the baseline.

## Decisions already made (owner-confirmed via Plannotator, do not relitigate)

- **Actions are `send | queue | steer` only. No interrupt/restart action.**
  `send` admitted only when idle; `queue` only when busy; `steer` only for the exact active run, native steering only, never a restart.
- No "acknowledge tool interruption" flag. `activeSteeringInterruptsTools` is exposed in the thread DTO for the client to warn; it does not gate admission.
- Auth fence is the **subject** `"watch-client"` (mirrors `"mcp-client"`), scopes `orchestration:read` + `orchestration:operate`. Not a new scope.
- Receipt table gained columns via migration **061** (amended in place twice; unreleased on this branch — don't run a dev DB that already applied an earlier 061 against it).
- A committed strict steer that fails afterwards is reported as receipt status **`failed`** (committed, not applied) — a third state next to `accepted` / `rejected`. The owner reviewed the full branch diff in Plannotator (`review --git --base fork/nightly`, 35 files) and submitted **LGTM with zero annotations** on 2026-10-10 22:07 PDT, so treat this as accepted.

## What is built (Slice B — server boundary — complete and green)

```
packages/contracts/src/watch.ts, watchAdmission.ts          DTOs, envelope, error codes, WatchAdmission
packages/contracts/src/environmentHttp.ts                    HttpApi group "watch": capabilities | threads | thread | command | commandReceipt
packages/contracts/src/orchestrationV2.ts                    message.dispatch += admission?, steerFollowUpPolicy?, principal?
apps/server/src/orchestration-v2/DispatchAdmission.ts        in-lock admission; parseAdmissionRejection(); dispatchPayloadFingerprint()
apps/server/src/orchestration-v2/{Orchestrator,EventSink,EffectOutbox,EffectWorker,CommandReceiptStore}.ts
apps/server/src/persistence/{OrchestrationCommandReceipts.ts, Migrations/061_CommandReceiptIdentity.ts}
apps/server/src/auth/{WatchAuth,WatchHttp,EnvironmentAuth,PairingGrantStore,RpcAuthorization,SessionStore}.ts
apps/server/src/cli/pair.ts                                  `pair --watch [--thread <id>]... [--project <id>]...`
apps/server/src/watch/{WatchService,WatchProjection,http,principal}.ts
apps/server/src/ws.ts                                        RpcAuthorization.layer(session.scopes, session.subject)
apps/server/src/server.ts                                    watch group + service layer registered
```

Routes: `GET /api/watch/v1/capabilities`, `GET /api/watch/v1/threads?cursor&limit` (default 20, max 50, pinned → recent, restriction filtered in SQL before `LIMIT`), `GET /api/watch/v1/threads/:threadId`, `POST /api/watch/v1/commands` (200 → `WatchCommandReceipt`), `GET /api/watch/v1/commands/:commandId`. Body cap 48 KiB; text ≤ 8000 scalars / 32 KiB.

Key invariants, each covered by a test:

- Admission runs **inside** `threadDispatch.withLock`, after receipt lookup, before planning (`Orchestrator.ts`, look for `DispatchAdmission`). Rejections are persisted as rejected receipts with `error = "admission:<code>"`.
- Same `commandId` + same fingerprint + same principal → original receipt. Different fingerprint or principal → `command_conflict`, no side effects, original row untouched. Legacy rows with null fingerprint keep old replay behavior.
- `steerFollowUpPolicy: "none"` is persisted through the outbox steer request; `EffectWorker` no longer synthesizes the `start_immediately` follow-up for it (default `"follow_up"` preserves upstream behavior — regression test exists).
- `watch-client` sessions are rejected by generic HTTP auth, RPC middleware, and WS tickets; accepted only by `WatchHttp.layerAuthenticatedAuth`. Handlers read `requireWatchSession` → `{ sessionId, restriction }`. Restriction is in signed claims, enforced on reads, writes, and receipt lookups (receipt for a hidden thread → `forbidden`, no existence leak).
- Provider-native subagents (`relationshipToParent === "subagent" && creationSource === "provider"`) are `isReadOnly` with `parentThreadId`; writes → `thread_read_only`.

### Verify it yourself

```sh
./node_modules/.bin/vp test run \
  packages/contracts/src/watch.test.ts packages/contracts/src/orchestrationV2.test.ts packages/contracts/src/environmentHttp.test.ts \
  apps/server/src/orchestration-v2/WatchAdmission.integration.test.ts apps/server/src/orchestration-v2/CommandReceiptIdentity.test.ts \
  apps/server/src/orchestration-v2/CommandPolicy.test.ts apps/server/src/orchestration-v2/SteeringCompletion.integration.test.ts \
  apps/server/src/orchestration-v2/FoundationPersistence.test.ts apps/server/src/orchestration-v2/EffectWorker.test.ts \
  apps/server/src/auth/WatchAuth.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/auth/EnvironmentAuth.test.ts apps/server/src/auth/PairingGrantStore.test.ts \
  apps/server/src/watch/WatchService.test.ts apps/server/src/relay/AgentAwarenessRelay.test.ts apps/server/src/ws.test.ts
# last result: 16 files, 243 passed
(cd apps/server && ../../node_modules/.bin/vp run typecheck)      # 0 errors
(cd packages/contracts && ../../node_modules/.bin/vp run typecheck)
```

Do not run repo-wide `vp check` / `-r typecheck` / `-r test` (AGENTS.md).

## What is built (Slices A + C — client side, simulator-built, not device-tested)

```
packages/watch-native/                        Swift package `T3WatchKit` (Swift 6, watchOS 26 / iOS 26 / macOS 15, no deps)
  Sources/T3WatchKit/WatchModels.swift        DTOs mirroring contracts/src/watch.ts; unknown activity → .unknown; open error-code set
  Sources/T3WatchKit/WatchTimestamp.swift     ms-exact ISO timestamps + sorted-key JSON encoder (envelope must re-encode byte-identically)
  Sources/T3WatchKit/WatchCommand.swift       envelope, text limits, allowed actions, WatchDraft (frozen target, pre-submit recheck)
  Sources/T3WatchKit/WatchClient.swift        URLSession client: 5 watch routes + /oauth/token exchange; errors decoded by shape not status
  Sources/T3WatchKit/CredentialStore.swift    Keychain (AfterFirstUnlock) + in-memory stores
  Sources/T3WatchKit/Submission*.swift        pure state machine (pending → unknown → receipt | not admitted) + atomic JSON file store + coordinator
  Tests/T3WatchKitTests/                      66 tests, fixtures are the real DTOs from the live smoke
apps/watch/T3Watch/                           SwiftUI watchOS app: Setup, Threads, Thread, Compose, Receipt (+ AppModel, Presentation)
apps/mobile/plugins/withT3Watch.cjs           Expo config plugin: adds the `T3Watch` watchOS target, embeds it in the iOS app, links T3WatchKit
apps/mobile/app.config.ts                     registers the plugin unconditionally (groupIdentifier null for Personal Team builds)
```

Verify: `cd packages/watch-native && swift test` (66 pass). App sources typecheck for the simulator with
`xcrun swiftc -typecheck -target arm64-apple-watchos26.0-simulator -sdk "$(xcrun --sdk watchsimulator --show-sdk-path)" -swift-version 6 -I packages/watch-native/.build/watchsim/out/Products/Debug-watchsimulator apps/watch/T3Watch/*.swift`
after `swift build --triple arm64-apple-watchos26.0-simulator --sdk "$(xcrun --sdk watchsimulator --show-sdk-path)" --scratch-path .build/watchsim` in the package. Full integration: `cd apps/mobile && APP_VARIANT=development EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform ios`, then `xcodebuild -workspace ios/T3CodeDev.xcworkspace -scheme T3Watch -destination 'platform=watchOS Simulator,id=6EFE7D72-2700-404B-8597-D06B25A53D49' build CODE_SIGNING_ALLOWED=NO` (and `-scheme T3CodeDev` on the iOS simulator; the built app contains `Watch/T3Watch.app`). Two clean prebuilds plus an incremental one were verified to produce byte-identical watch entries in the pbxproj.

**Blocker on this host, upstream not ours:** Xcode 27.2 beta refuses to load the generated project at all (`The reference "Info.plist" is a member of more than one group`) because `expo-widgets` and `expo-sharing` each place one `Info.plist` file reference in two groups. Nothing iOS builds after prebuild, with or without our plugin. Slice A's throwaway fix lives gitignored at `apps/mobile/.generated/fix-shared-infoplist.cjs` (run it on `ios/T3CodeDev.xcodeproj/project.pbxproj` after every prebuild); a real fix belongs in those plugins or a stable Xcode. `apps/mobile/.generated/dd/` holds ~6 GB of DerivedData — delete freely.

Decisions taken in the client (recheck against taste):

- The app target compiles in Swift 5 language mode with `SWIFT_STRICT_CONCURRENCY = complete` (plugin follows the iOS target's `SWIFT_VERSION`); the package is Swift 6. Sources typecheck in both; pass `swiftVersion: "6.0"` to the plugin to switch.
- `client_device_type=mobile` on the exchange (there is no `watch` value in `AuthClientMetadataDeviceType`); only `bot` was tried live.
- Steer/Queue are never preselected; Send is preselected only when it is the only option. Queue is not gated on `supportsQueuedMessages` (the queue is server-side).
- Expiry vs clock skew: "not admitted" is reported only once the Watch clock passes `notAfter` + 30 s with no receipt; inside that window it waits rather than resends.
- After `command_conflict` on POST the client fetches the receipt by command ID and shows the original; otherwise "outcome unknown", never resend.
- One stored credential / one environment. Multi-environment, "forwarded through phone", and QR/phone-assisted setup are Slice D.
- React Native's CocoaPods `post_install` copies the iPhone's aggregated `PrivacyInfo.xcprivacy` into the watch target. Harmless; do not drop a manifest into `apps/watch/T3Watch/` naively.

## Live E2E smoke against a real provider (done 2026-10-11, all green)

Run on this host against a dev server in this worktree (`./node_modules/.bin/vp run dev`, seeded with `vp run migrate-dev-db`), provider **Codex `gpt-6-astra`** in `approval-required` mode, project `shuv2code-nightly`. Everything below was observed over the real `/api/watch/v1` routes with a real `watch-client` session, then confirmed in the persisted V2 projection the normal client reads.

| Case                                                       | Result                                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pair --watch` → `/oauth/token` exchange                   | Bearer with scopes `orchestration:read orchestration:operate`, subject `watch-client`                                                              |
| Watch token on generic HTTP (`/api/auth/session`)          | `authenticated: false`; ordinary client token on `/api/watch/v1/*` → 401                                                                           |
| `steer` with live `activeRunId` mid-run                    | `accepted`; Codex abandoned its file-reading loop and replied `WATCH-STEERED` **2.7 s** after the receipt; still one run, no synthesized follow-up |
| Identical envelope replay                                  | Byte-identical original receipt                                                                                                                    |
| Same `commandId`, different text                           | `rejected` / `command_conflict`, original receipt untouched                                                                                        |
| `send` while busy · `steer` stale run · `notAfter` in past | `rejected` / `thread_busy` · `stale_target` · `expired` (each persisted as a rejected receipt with `principal` + fingerprint)                      |
| Wrong `environmentId`                                      | `WatchRequestError` `environment_mismatch`                                                                                                         |
| `--thread`-restricted grant                                | List shows only the allowed thread; GET thread, GET receipt, and POST on a hidden thread all → `forbidden` (no existence leak)                     |
| `send` on idle thread, then `queue` while it ran           | `send` → run 2 (`WATCH-SENT…`); `queue` → `queuedCount: 1` until run 2 finished, then run 3 answered `WATCH-QUEUED`                                |

**Recipe** (reproducible; helper scripts live gitignored at `apps/server/.logs/watch-e2e/{launch,dispatch}.ts` in this worktree — they open an Effect `RpcClient` over `ws://127.0.0.1:<port>/ws?orchestrationProtocol=2` with an `Authorization: Bearer` header, pattern from `apps/server/integration/NetworkTransferMeasurement.integration.ts`):

1. `vp run migrate-dev-db` (dev server stopped), then `vp run dev` in the background; read `serverPort` from the `[dev-runner]` line.
2. `node apps/server/src/bin.ts auth session issue --base-dir <worktree>/.t3 --scope orchestration:read --scope orchestration:operate --json` → ordinary client bearer for the WS helpers.
3. `launch.ts <port> <tokenFile> <projectId>` calls `orchestration.launchThread` with an initial message. Codex `approval-required` maps to the `untrusted` policy, so approve its command requests with `dispatch.ts … '{"type":"runtime-request.respond","threadId":…,"requestId":<pendingAttention.runtimeRequest.id>,"decision":"acceptForSession"}'`.
4. `pair --watch [--thread <id>]` → POST `/oauth/token` form fields `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<credential>`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`, `requested_token_type=urn:ietf:params:oauth:token-type:access_token`.
5. `curl` the watch routes. Stop the dev server by the PIDs you tracked (the `vp` wrapper exits before its server/web children; check each port owner's cwd before killing).

## Known rough edges

1. **Error codes are stringly-typed in receipts** (`"admission:<code>"` parsed by `parseAdmissionRejection`). Works, tested, but a typed column would be cleaner. Low priority unless it bites.
2. **`WatchRequestError` is always HTTP 400**, including `forbidden` and `not_found` (`packages/contracts/src/environmentHttp.ts`, `httpApiStatus: 400`). The Swift client must branch on `error.code`, never on the status. Mapping `forbidden` → 403 / `not_found` → 404 is a small contract change if wanted.
3. **`latestAssistantExcerpt` is the last _completed_ assistant message.** While a run streams, the thread DTO still shows the previous run's final text. The Watch UI must pair the excerpt with `activity`, or it will look stale.
4. **No way to mint a watch grant from the UI.** Only `node apps/server/src/bin.ts pair --watch ...` (prints JSON with `origin`, `credential`, `expiresAt`, `exchangePath`). In dev the printed `origin` is the Vite web URL; the server port accepts the same requests directly. Connections settings UI is Slice C/E work.
5. **Untested live:** steering while a runtime request (tool approval) is pending — the smoke approved the request immediately before steering. Claude was not exercised (the owner's threads are all Codex); its adapter reports the same `supportsActiveSteering: true` constant.
6. **The Watch app has never talked to a server.** Next integrated step: prebuild (+ the Xcode 27.2 workaround), install `T3Watch.app` on the Watch simulator, run the dev server, `pair --watch`, type the credential into Setup, and drive a steer against a live Codex thread exactly as in the E2E section. Needs simulator UI interaction (computer use); ask the owner first.
7. **`notAfter` is part of the receipt fingerprint** (`dispatchPayloadFingerprint` hashes `DateTime.formatIso`), so any client that re-encodes the envelope with different precision turns a retry into `command_conflict`. T3WatchKit truncates to milliseconds and encodes deterministically; a test proves byte-identical re-encoding. Keep this in mind for the Slice D phone relay — forward bytes, never re-serialize.

## What's next (RFC §10)

- **Slice A** — software half done (plugin, two-clean-prebuild proof, identity audit below). Still open and hardware-only: system dictation returning reviewable text on a paired Watch; automatic signing creating the `.watchkitapp` App ID; whether EAS `appExtensions` provisions a watch app (it is designed for extensions); device install. Identity audit (dev variant): iOS bundle `com.t3tools.t3code.dev` (`app.config.ts:74–99`) → watch gets `${ios}.watchkitapp`, companion = iOS id; team `ARK85ZXQ4Z` (`:258`) left unset on the watch target so Expo's team mod / `expo run:ios` stamps it; keychain group `$(AppIdentifierPrefix)com.t3tools.t3code.dev` (`:264`, uses the non-Personal-Team id — pre-existing fork bug) not needed by the watch; app group `group.<ios id>` declared via `ios/T3Watch/T3Watch.entitlements` + EAS entry, skipped for Personal Teams; EAS project `d763fcb8-…`, `owner: pingdotgg` (`:244`, `:496`, `:499`) — a fork must replace all three or it updates against upstream; push/URL scheme/Clerk relying party: nothing watch-side yet. `apps/mobile/src/widgets/AgentActivity.tsx:316` Smart Stack Live Activity rides on `expo-widgets` and is mirrored from the iPhone, independent of `T3Watch`.
- **Slice C** — code complete and simulator-built (see "What is built"). Exit criterion still needs the integrated run (rough edge 6) and hardware for dictation, Keychain across lock/reboot, haptics, and direct tailnet reachability from the Watch. Host has Xcode 27.2 (beta, see blocker) with the watchOS 27.2 SDK, a watchOS 26.5 simulator (`SHark Watch MVP`, UDID `6EFE7D72-2700-404B-8597-D06B25A53D49`), and a paired physical iPhone (`shuvphone`).
- **Slice D** (phone relay): WCSession bridge as a native Expo module, forwards the identical envelope with the watch credential — never the phone's session.
- **Slice E**: Stop (`run.interrupt` with `holdQueue` — a bare interrupt is _not_ UI Stop), complications, Connections UI for watch grants, notifications.

## Source facts the RFC got wrong (so you don't re-derive them)

- Turn capabilities are mostly **static adapter constants**, not negotiated per session (Codex `CodexAdapterV2.ts:225–250`, Claude `ClaudeAdapterV2.ts:192–218`, Cursor has no native steer). Read them from the session anyway.
- Upstream `start_immediately` queues when busy and `queue_after_active` starts when idle — hence the strict admission layer.
- Upstream `EffectWorker` converts a failed steer into a new follow-up turn — hence `steerFollowUpPolicy`.
- `OrchestrationV2ThreadShell.projectId` is non-null upstream; the Watch DTO makes it nullable.
- There was no cursor/pagination API; `ThreadManagementService.listWatchThreadIds` + `WatchProjection.ts` add a bounded one.

## Process conventions in force

- Global prefs live in `/Users/shuv/AGENTS.md`: Plannotator (`--tailscale`, open locally, SHark the tailnet URL) for plan/spec/code review; `sharkctl` for pings; board key prefix `<harness>-shuvbot:`; papercuts CLI for recurring friction. Board items so far: `claude-code-shuvbot:t3-watch:spec-review` (closed), `claude-code-shuvbot:t3-watch:e2e-smoke` (done), `claude-code-shuvbot:t3-watch:slices-a-c` (done).
- **Delegating through T3 orchestration from an OpenCode thread:** the `t3-code` MCP tools are not attached when OpenCode runs as an external server (`hasT3Mcp` is false in `packages/provider-opencode/src/server/adapter.ts`), so threads were launched over the live server's WS RPC (`orchestration.launchThread`, port 3773) with a bearer obtained from `~/.t3/runtime/versions/<running version>/t3 pair` + `/oauth/token`. Use the **running server's own binary** for `pair`, never the worktree's `bin.ts` — that would apply this branch's migration 061 to the live DB. Helper: `apps/server/.logs/watch-e2e/launch-live.ts` (gitignored). Cursor instances that worked: `cursor_pool_0eacce5f`, `cursor_pool_43fef3a5`, model `claude-opus-5-5`, `full-access`. Plannotator's submitted decisions for this project are in `~/.plannotator/feedback/shuv2code-nightly/index.jsonl`.
- **Never open an upstream PR.** A PR to `shuv1337/shuv2code` only when the owner explicitly asks.
- Conventional commits; `git add` by explicit path; this worktree is shared with parallel agents, so never `git add -A`, stash, or reset other people's files.
