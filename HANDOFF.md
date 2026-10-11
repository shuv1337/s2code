# HANDOFF — T3 Watch (Apple Watch voice control)

Written 2026-10-10 ~17:30 PDT by Claude (Fable 5.1) orchestrating Astra build agents. Read this, then `docs/rfcs/watch-voice-control.md`, then `AGENTS.md`.

> This file fights `AGENTS.md` ("do not commit plans or agent scratch files"). It is committed because the
> owner asked for a durable handoff. Delete it before anything is proposed upstream.

## Where things are

| Thing                 | Value                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fork                  | `git@github.com:shuv1337/shuv2code.git` (`origin`); upstream `pingdotgg/t3code`                                                                                                                            |
| Worktree              | `/Users/shuv/repos/shuv2code-nightly` (a linked worktree of `/Users/shuv/repos/shuv2code`; that main checkout holds the **old, rebranded** fork with uncommitted mobile-branding work — leave it alone)    |
| Base                  | `upstream-nightly` = `fork/nightly` = `4f63275ac` = tag `v0.0.46-nightly.20261010.2948` (published 2026-10-10 14:39 PDT). Pristine upstream; **not** rebranded; package name is still `@t3tools/monorepo`. |
| Work branch           | `feature/watch-server`, pushed, 9 commits ahead of `fork/nightly`, working tree clean                                                                                                                      |
| Tooling               | **Use `./node_modules/.bin/vp`**, not global `vp` — the global one launches an incompatible Vitest 4 here (papercut `pc_28654f08f725`). Deps are installed.                                                |
| Plan/review artifacts | Outside the tree: `/private/var/folders/22/x85ftt9s769dkyr6b_37ys4c0000gn/T/shuvcode/t3-watch-{review-and-plan,brief}.md`                                                                                  |

Upstream has **no `nightly` branch**; nightlies are tags cut from `main`. To rebase onto a newer nightly: `git fetch upstream --tags`, fast-forward `upstream-nightly` to the new tag, rebase `feature/watch-server`.

## Decisions already made (owner-confirmed via Plannotator, do not relitigate)

- **Actions are `send | queue | steer` only. No interrupt/restart action.**
  `send` admitted only when idle; `queue` only when busy; `steer` only for the exact active run, native steering only, never a restart.
- No "acknowledge tool interruption" flag. `activeSteeringInterruptsTools` is exposed in the thread DTO for the client to warn; it does not gate admission.
- Auth fence is the **subject** `"watch-client"` (mirrors `"mcp-client"`), scopes `orchestration:read` + `orchestration:operate`. Not a new scope.
- Receipt table gained columns via migration **061** (amended in place twice; unreleased on this branch — don't run a dev DB that already applied an earlier 061 against it).
- A committed strict steer that fails afterwards is reported as receipt status **`failed`** (committed, not applied) — a third state next to `accepted` / `rejected`. This was the orchestrator's call, not in the plan; the owner has seen it in review but not explicitly signed off.

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

## Known rough edges (fix these first)

1. **Error codes are stringly-typed in receipts** (`"admission:<code>"` parsed by `parseAdmissionRejection`). Works, tested, but a typed column would be cleaner. Low priority unless it bites.
2. **`failed` receipt status** needs explicit owner sign-off (see Decisions).
3. **No way to mint a watch grant from the UI.** Only `node apps/server/src/bin.ts pair --watch ...` (prints JSON with origin, credential, expiry, exchange path; exchange happens at the existing `/oauth/token`). Connections settings UI is Slice C/E work.
4. **No end-to-end run against a real provider yet.** Everything is proven with the fake adapter. Slice C exit criterion is "a dictated steer affects the chosen running thread and is visible in the normal T3 client" — the first thing to do with real hardware/provider is: start a Claude or Codex thread (both report `supportsActiveSteering: true`), `pair --watch --thread <id>`, exchange, then `curl` a `steer` with the live `activeRunId` and watch it land.
5. **Review was opened but not acted on.** Plannotator review of the branch diff was launched (`plannotator review --git --base fork/nightly --tailscale`); any annotations the owner leaves are in Plannotator's session store (`plannotator last` / `plannotator sessions`). Check before changing anything.

## What's next (RFC §10)

- **Slice A** (hardware spike, not started): prove a native watchOS target survives `expo prebuild --clean` via a config plugin (pattern: `apps/mobile/plugins/withShareExtensionDisplayName.cjs`, local modules under `apps/mobile/modules/t3-native-controls/`); prove system dictation returns reviewable text on a paired Watch. Fork identity needs an audit: bundle IDs hard-coded in `apps/mobile/app.config.ts:74–99`, keychain group `:264`, EAS project `:496`. **Note:** `apps/mobile/src/widgets/AgentActivity.tsx:316` already ships a watchOS Smart Stack Live Activity card — the RFC missed this; reuse its identity/entitlement surface.
- **Slice C** (voice loop): Swift package (`packages/watch-native/`) with DTOs mirroring `packages/contracts/src/watch.ts`, URLSession client, durable local envelope before first send, receipt reconciliation; SwiftUI app under `apps/watch/`. Start with watchOS 26 unless hardware says otherwise.
- **Slice D** (phone relay): WCSession bridge as a native Expo module, forwards the identical envelope with the watch credential — never the phone's session.
- **Slice E**: Stop (`run.interrupt` with `holdQueue` — a bare interrupt is _not_ UI Stop), complications, Connections UI for watch grants, notifications.

## Source facts the RFC got wrong (so you don't re-derive them)

- Turn capabilities are mostly **static adapter constants**, not negotiated per session (Codex `CodexAdapterV2.ts:225–250`, Claude `ClaudeAdapterV2.ts:192–218`, Cursor has no native steer). Read them from the session anyway.
- Upstream `start_immediately` queues when busy and `queue_after_active` starts when idle — hence the strict admission layer.
- Upstream `EffectWorker` converts a failed steer into a new follow-up turn — hence `steerFollowUpPolicy`.
- `OrchestrationV2ThreadShell.projectId` is non-null upstream; the Watch DTO makes it nullable.
- There was no cursor/pagination API; `ThreadManagementService.listWatchThreadIds` + `WatchProjection.ts` add a bounded one.

## Process conventions in force

- Global prefs live in `/Users/shuv/AGENTS.md`: Plannotator (`--tailscale`, open locally, SHark the tailnet URL) for plan/spec/code review; `sharkctl` for pings; board key prefix `<harness>-shuvbot:`; papercuts CLI for recurring friction. Board item for this work: `claude-code-shuvbot:t3-watch:spec-review` (currently `review`).
- **Never open an upstream PR.** A PR to `shuv1337/shuv2code` only when the owner explicitly asks.
- Conventional commits; `git add` by explicit path; this worktree is shared with parallel agents, so never `git add -A`, stash, or reset other people's files.
