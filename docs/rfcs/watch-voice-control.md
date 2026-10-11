RFC: T3 Code V2 — Apple Watch voice control

Status: Proposed; source-reviewed, not implemented or device-tested.
Date: 2026-10-10
Working feature name: T3 Watch (not a final product identity).
Repository baseline: Fresh fork of pingdotgg/t3code; no dependency on shuv1337/shuv2code.
Pinned upstream release: v0.0.46-nightly.20261010.2948
Pinned commit: 4f63275ac7885281d245022e65f1e9e8816b1382
Release publication: 2026-10-10 21:39:05 UTC / 14:39:05 PDT.

1. Decision and scope

Build a native SwiftUI watchOS companion that lets its owner select an existing T3 thread, dictate an instruction, choose its delivery behavior, and see a server-backed acknowledgment. Execution, provider credentials, filesystem access, scheduling, and conversation history remain on the thread’s owning T3 environment.

This is a small control client for Orchestrator V2, not a new agent, an iPhone rewrite, or a miniature IDE. The first useful milestone must include steering an already-running thread; merely appending a message to an idle thread is insufficient.

V2 is the orchestrator generation, not a v2.x release tag. At research time, the stable release was v0.0.45; V2 was in the 0.0.46 nightly line. The latest nightly returned by the live release listing was the pinned build above. Its Git tag was independently resolved to the same commit. Do not substitute a maintainer preview release or whatever happens to be on main when implementation begins. [S1–S3]

Explicit exclusions

No old-fork code or branding migration. No dependence on the unmerged Swift mobile rewrite branch. No custom provider integrations, SSH command injection, terminal keystroke injection, standalone conversation database, or second server-side queue. No new project/thread creation, provider switching, file editing, tool approval, or model/runtime-mode changes from the Watch in the initial release.

No guaranteed background streaming, offline dictation, phone VPN inheritance, or phone-free installation is promised. Independent operation after pairing and independent installation/onboarding are separate capabilities.

2. Verified upstream foundation

The review read the following files at the pinned commit, not just current default-branch search snippets:

| Existing location                                         | Verified relevance                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/package.json`                                | iPhone/mobile client remains Expo/React Native. Native run scripts invoke `expo prebuild --clean`.                                                                                                                              |
| `packages/contracts/src/orchestrationV2.ts`               | Exposes turn capabilities including `supportsActiveSteering`, `activeSteeringInterruptsTools`, `supportsSteeringByInterruptRestart`, `supportsQueuedMessages`, and `supportsInterrupt`.                                         |
| `apps/server/src/orchestration-v2/CommandPolicy.ts`       | Current command is `message.dispatch`; dispatch modes include `start_immediately`, `steer_active`, `restart_active`, and `queue_after_active`. Intent resolution uses serialized thread state.                                  |
| `apps/server/src/orchestration-v2/Orchestrator.ts`        | Integrates command policy, receipts, projection storage, event sink, and thread command execution. Provider-native subagent threads can reject direct messages.                                                                 |
| `apps/server/src/orchestration-v2/CommandReceiptStore.ts` | Persisted accepted/rejected receipts include command ID, thread ID, command type, result sequence, and error.                                                                                                                   |
| `docs/internals/overview.md`                              | Describes V2’s transactional intent/events/projection/receipt/outbox boundary, and distinguishes command acknowledgment from provider completion.                                                                               |
| `docs/internals/environment-auth.md`                      | Existing sessions have scoped authority; cookie, bearer, and DPoP mechanisms share that authority. MCP credentials have a separate audience restriction. Ordinary pairing does not imply permission to mint more pairing links. |

Sources: [S4–S10].

Important: docs/orchestration-v2/feature-lifecycles.md explicitly describes target behavior. Do not copy its illustrative thread.message.send shape as the current wire API; use current contracts and message.dispatch in the implementation. [S7, S11]

The earlier investigation found a closed, unmerged PR concerning Apple Watch Smart Stack Live Activities, not a confirmed standalone Watch client. This RFC does not depend on that PR and does not claim an exhaustive renewed audit of every active upstream branch. [S12]

3. Product behavior

3.1 Main interaction

Open the app or a complication; choose a pinned/recent thread; open text entry and dictate; review the text and target; select the available delivery action; receive acknowledgment.

Keep the environment name, project name, and thread title visible during composition and review. Freeze environmentId and threadId when composition begins. A sidebar reorder, phone navigation change, new incoming activity, or thread rename must never retarget the draft.

Do not auto-send when dictation closes. Do not silently rewrite the transcript with another model. A voice transcript is the user’s instruction, not an invitation for a routing model to pick a vaguely similar project.

3.2 Screens

Threads: Pinned entries, then actionable/recent entries. Show environment, project or “No project,” thread title, activity state, connectivity, and last-refresh age. Fetch a small page, initially 20 entries, with pagination. Keep pins stable rather than continuously sorting the row the user is reaching for. One offline environment must not block the others.

Thread: Show identity, provider instance label, the latest short assistant excerpt, current activity, pending question/approval indication, and available input actions. Bounded context is enough; do not download a full transcript or tool logs. Provider-native subagents that cannot receive messages link to their parent instead.

Compose/review: Show transcript, delivery action, target identity, and any disruption warning. Support re-dictate, edit, cancel, and explicit submit. Longer transcripts scroll; they are not silently truncated.

Receipt/result: Distinguish local submission, forwarding through the phone, committed intent, queued work, observed provider activity, failure, and unknown delivery. The confirmation haptic means the environment committed the command, not that the agent finished it.

3.3 Delivery behavior

| Watch action             | Required intent                                        | Implementation boundary                                                                                                 |
| ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Send                     | Start work on an idle existing thread                  | V2 `message.dispatch` / `start_immediately`, subject to current-state admission.                                        |
| Steer                    | Redirect the selected active run using native steering | V2 `steer_active` with an explicit target run and a no-restart admission constraint.                                    |
| Queue                    | Add the instruction behind active work                 | V2 `queue_after_active`; reuse V2’s server-side queue.                                                                  |
| Interrupt & redirect     | Explicitly authorize interrupt/restart steering        | V2 `restart_active`; separate confirmation and capability validation.                                                   |
| Stop, later in v1 polish | Stop according to the current T3 UI semantics          | Reuse the existing server operation after tracing and testing it; do not approximate Stop with a provider-process kill. |

V2 can select interrupt/restart as a steering implementation. Therefore, checking only the word “steer” is insufficient. A Watch request labeled native Steer must reject rather than silently turn into restart steering. Likewise, activeSteeringInterruptsTools must trigger a warning where reported. Provider capabilities are session/instance state, not a hard-coded provider-brand table. [S6–S7]

For a thread preparing or starting a run, prefer Queue until native steering is actually available. If the run or provider changes while the user dictates, preserve the draft and ask for a fresh delivery choice. Never steer the next run just because it is now the newest run.

4. Voice input

Initial implementation: system text entry and dictation

Use SwiftUI’s native text-entry experience, with a small supported WatchKit text-input adapter only if needed. The WatchKit system text-input controller explicitly provides dictation and a completion result. Wrap it behind DictationInput so implementation details do not leak into thread or transport state. [S13–S14]

The initial UI may require choosing the system microphone within text entry. Do not promise a custom, single-tap streaming waveform that system dictation does not expose. The app receives and submits text; it does not implement its own audio upload in this milestone.

Do not assume iPhone speech APIs or a particular on-device transcription model are available on the target Watch. Do not claim Apple dictation is always offline or locally processed. Validate supported devices, locales, network conditions, and permission/settings failures on hardware.

Later option: explicit push-to-talk recording

Only pursue custom recording if system dictation is materially too slow or inaccurate for repository names and technical language. Record a bounded clip on Watch and transcribe through an explicitly configured iPhone or environment service. Add cancellation, upload limits, retention policy, and explicit disclosure of where audio is processed. This is an independent transcription feature, not a dependency of V2 steering.

5. Architecture

Recommended: shared small HTTPS protocol, two delivery paths

• Native SwiftUI Watch app owns UI, drafts, compact cache, and transport-pending requests.
• A small Swift package contains the versioned client DTOs, HTTPS client, receipt reconciliation, and request serialization.
• The existing Expo iPhone app gets a native WatchConnectivity module. It handles setup and can forward the same request via HTTPS without depending on a running React Native screen or JavaScript event loop.
• Each T3 environment gets a small authenticated Watch HTTP adapter. It projects current V2 state and dispatches into existing V2 services.

The Watch can use HTTPS directly when the endpoint is reachable. Otherwise, its native iPhone counterpart forwards the same envelope to that environment. Both paths preserve command ID, message ID, target, expiry, and request contents. There is still one authoritative execution path: the environment’s V2 orchestrator.

Apple recommends URLSession for server communication and identifies WatchConnectivity as the companion-app transport. This makes short HTTP operations a suitable boundary; continuous WebSocket operation is not an acceptance requirement. [S15–S16]

Alternatives and tradeoffs

WatchConnectivity-only prototype: smallest initial Watch networking surface and convenient for private endpoints reached by the phone. It depends on companion availability and offers no direct phone-away route. Suitable for an early spike, not the full target architecture.

Direct Swift client for existing Effect RPC: reduces extra server HTTP surface, but requires faithfully implementing current RPC framing, auth/tickets, subscriptions, cancellation, and reconnect behavior in Swift. Keep this as an option only if a small compatible native client proves simpler than the adapter; do not port the entire TypeScript runtime to a watch.

Watch HTTP adapter plus native phone fallback — selected: adds a small server surface but avoids a second orchestration layer and uses the same simple protocol on both Apple devices. Favor this for a maintainable fork.

The HTTP adapter is an interface adapter, not a standalone sidecar with its own database, queue, credentials, or agent loop.

6. Proposed Watch API

Everything in this section is new proposed surface, not an upstream endpoint claim.

| Route                                    | Responsibility                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/watch/v1/capabilities`         | Protocol version, authoritative environment ID, supported features and limits. |
| `GET /api/watch/v1/threads`              | Paginated compact authorized thread list.                                      |
| `GET /api/watch/v1/threads/{threadId}`   | Compact selected-thread snapshot and action capabilities.                      |
| `POST /api/watch/v1/commands`            | Validate and admit one allowed command into V2.                                |
| `GET /api/watch/v1/commands/{commandId}` | Authorized lookup of the existing V2 receipt and correlated observed state.    |

Use the existing pairing/session exchange machinery; do not create another unrelated password/token system. Any added audience restriction or watch-specific grant must be integrated into environment auth, not implemented as an unchecked UI label.

6.1 Thread summary DTO

Include environmentId, threadId, nullable projectId, environment/project/thread labels, provider instance identity, bounded latest message excerpt, current run identity, capability flags, queue summary, pending-attention summary, source freshness, and a snapshot revision/cursor suitable for this projection.

Preserve unknown future activity states as an explicit unknown state; they must not default to idle, complete, or safe-to-steer. Local pins are navigation preferences, not authorization rules.

6.2 Illustrative command envelope

{
"protocolVersion": 1,
"commandId": "<uuid-created-on-watch>",
"messageId": "<uuid-created-on-watch>",
"environmentId": "<owning-environment-id>",
"threadId": "<existing-thread-id>",
"action": "steer",
"targetRunId": "<run-seen-at-confirmation>",
"expectedProviderInstanceId": "<provider-instance-id>",
"text": "Leave the UI alone for now. Fix the failing integration tests first.",
"allowInterruptRestart": false,
"notAfter": "<UTC timestamp>"
}

This is a Watch protocol envelope, not the upstream OrchestrationV2Command schema. The TypeScript adapter constructs and validates the real V2 command from the pinned contracts. Clients never submit a provider configuration, runtime mode, permission change, arbitrary RPC name, shell command, or full arbitrary V2 command.

Proposed limits: text at most 8,000 Unicode scalar values and 32 KiB UTF-8; request body at most 48 KiB; 90-second first-admission deadline for run-targeted control requests. Treat these as tunable product defaults, not upstream limits. Return explicit errors rather than truncate.

6.3 Atomic admission and receipt order

1. Authenticate and authorize the request on its environment, including audience and any target restrictions.
2. Validate the envelope and immutable identity; never resolve the target by title.
3. Check for an existing command receipt. A matching previously committed request returns its original receipt even if the run has since finished or the request has expired.
4. Reject reuse of the same command ID for different request contents. The reviewed receipt DTO does not establish complete payload-fingerprint enforcement; verify this and, if missing, add minimal fingerprint/ownership metadata transactionally to the receipt path.
5. For a genuinely new command, under the existing thread command serialization boundary, validate expiry, thread writability, targeted run, provider instance, capabilities, and disruption permission.
6. Dispatch through the existing V2 command policy and commit its existing events/projections/receipt/outbox transaction.
7. Return committed receipt information, not a speculative “agent received it” claim.

A check in the HTTP route followed by an unguarded dispatch is not sufficient; state could change between them. If the existing dispatcher lacks a suitable precondition hook, add a small typed admission constraint evaluated within its existing thread lock. Do not introduce a separate Watch queue or lock hierarchy.

Avoid using deliveryIntent: "auto" for a strict, run-targeted native-steer action: the current resolver selects behavior from whichever run is active when it executes. Explicit target and restart/tool-interruption constraints are necessary for the promised Watch behavior. [S7]

6.4 Retry semantics

Persist the finalized envelope locally before first submission. Automatic transport retries reuse exactly that envelope and ID, whether direct or relayed. An edited or freshly reconfirmed instruction gets a new ID, but only after resolving any uncertain earlier submission.

A missing response means delivery is unknown, not failed. Query the receipt, then safely retry the same request if appropriate. A missing receipt in one lookup does not prove an in-flight request cannot commit later.

V2 already provides durable intent receipts and an effect outbox. Reuse them. Do not advertise exactly-once provider execution: a provider/process failure may leave downstream execution uncertain even though command admission is unambiguous. [S5, S8–S9]

Expired requests must never be newly admitted. A stored receipt can still be retrieved after expiry. Disable “resend as new” while prior execution is unresolved; if a user later chooses a new action, clearly distinguish it from transport retry.

7. Authentication and authorization

Give each Watch a separately revocable environment session. Keep provider credentials on the environment; keep Watch session secrets in native Keychain storage rather than JavaScript, app logs, screenshots, URLs, or WidgetKit payloads.

Reuse existing session machinery. For a narrowly privileged release, add an explicit Watch audience/policy using the same pattern of separate audience enforcement already present for MCP. Permit only the small Watch read and command surfaces plus required session-lifecycle operations. Reject the Watch credential on generic RPC, terminal, filesystem, arbitrary orchestration, access-management, and approval routes. This is proposed work; existing generic read/operate scopes alone must not be described as an existing-thread-only security boundary. [S10]

The bridge must forward with the Watch’s restricted authority, not upgrade requests to the phone’s broader session. Where optional thread/project restrictions are offered, enforce them on both read and write operations and on every receipt lookup. A pin or hidden UI action is not an access-control rule.

Pairing flow

An authorized owner uses the existing desktop/server access-management flow to create the intended limited grant. The phone can scan or carry a short-lived bootstrap token to the Watch, where it is exchanged for the Watch session. Do not assume an ordinarily paired mobile session has access:write and can mint child grants; upstream explicitly prevents that assumption. Direct and phone-relayed operation must refer to the same Watch identity and restriction set. [S10]

The initial product can require an iPhone for setup while still supporting direct operation after setup. A completely phone-free installation and enrollment experience is a later, separately designed milestone.

Authorization to send an instruction is still authority to cause agent work within that thread’s existing permission mode. “No filesystem API on the Watch” does not mean the agent cannot modify files. Existing provider sandbox, approval, and runtime policies remain authoritative.

8. Connectivity, background behavior, and status

Prefer a recently proven direct HTTPS route when configured. Use the phone bridge when direct access is unavailable and the companion is reachable. Track route health per environment rather than globally.

Do not assume a private tailnet hostname is reachable on standalone Watch cellular simply because it works on the paired iPhone. Verify DNS, routing, TLS, authentication, and the actual request on hardware. A phone-away path needs an endpoint genuinely reachable in that mode. A tunnel or upstream relay route is an operator choice, not a reason to expose an unauthenticated control server.

For immediate phone exchange, use WCSession.sendMessage/sendMessageData with replies and error handling. Use updateApplicationContext only for replaceable snapshots, not a command log. Background transfers are opportunistic; they must not quietly replay time-sensitive steering instructions later. [S17]

Implement the iPhone relay in native code and initialize it independently of any screen. Reuse the Swift HTTP client. Phone receipt is not environment acceptance; acknowledge forwarding separately and reconcile with the server receipt after deadlines or process suspension.

Refresh status on launch, resume, explicit refresh, and after a submission. While the selected thread remains foregrounded, begin with adaptive polling in the 3–10 second range and back off after inactivity/errors. This is a proposed tuning range, not a background execution guarantee. Cache snapshots with visible age.

WatchOS background tasks are system-managed and do not provide an always-running client. Use lifecycle-aware foreground requests and supported background APIs for suitable transfers; retain unresolved command identity across suspension. Do not misuse workout or audio background modes just to keep a coding-agent connection alive. [S16, S18]

Initial feedback is in-app and foreground haptics. Notifications, persistent completion alerts, and live complications require separate delivery work and must not be implied by a successful foreground demo. Later push support should use the fork’s own application identity and configured infrastructure, with minimal lock-screen content and fresh state validation after a tap.

9. Repository and build plan

All paths below are proposed additions, not claims that these directories already exist:

apps/watch/ # SwiftUI app sources, resources and tests
packages/watch-native/ # Swift package shared by Watch and native iOS bridge
apps/mobile/modules/t3-watch-bridge/ # Local Expo native module, WCSession lifecycle
apps/mobile/plugins/withT3Watch.ts # Reproducible target/embed/signing configuration
packages/contracts/src/watch.ts # Versioned narrow DTOs; validated adapter inputs
apps/server/src/watch/ # HTTP projection/dispatch adapter
apps/server/integration/watch/ # Auth, race, receipt, queue and provider behavior tests
docs/rfcs/watch-voice-control.md # This RFC
UPSTREAM_BASE.json # Verified upstream tag, SHA, and review date

Keep Watch source outside generated apps/mobile/ios. Upstream invokes expo prebuild --clean; Expo documents that this deletes generated native projects. Recreate the Watch target, embedded products, native bridge registration, and signing configuration through source-controlled config/plugin inputs. Test repeated clean prebuilds and incremental regeneration for duplicate targets or build phases. [S4, S19]

Use SwiftUI and current Swift concurrency. Start with a chosen minimum of watchOS 26 for the new target unless hardware requirements justify lowering it; this is a product choice, not upstream’s declared requirement. Pin the working Xcode/SDK pair in CI after proving the current upstream iPhone build and the Watch target build together. Use the same supported source-controlled build paths locally and in CI.

Preserve upstream’s Vite+ workflow and lockfile. This is not the right feature branch for a package-manager migration. Bun is suitable for isolated new helpers where compatible, but must not rewrite dependency management accidentally. [S20]

Use independent bundle/application IDs and signing settings for fork builds. Configure update, push, and hosted endpoints explicitly; do not accidentally ship a fork that auto-updates back to upstream or expects upstream-owned service credentials. Prefer scoped identity/config changes, not a repository-wide rebranding pass.

Clean source baseline

Example local preparation; these commands do not create or overwrite a GitHub fork:

git clone https://github.com/pingdotgg/t3code.git t3code-watch
cd t3code-watch
git remote rename origin upstream
git fetch upstream tag v0.0.46-nightly.20261010.2948
git switch -c feature/watch-voice v0.0.46-nightly.20261010.2948
test "$(git rev-parse HEAD)" = "4f63275ac7885281d245022e65f1e9e8816b1382"

Set origin only after choosing/creating the new fork. Keep the upstream reference recorded and update deliberately with contract regression tests. Do not silently move the baseline during implementation.

A clean Git checkout is not an isolated runtime. Develop against disposable environment data and test fixtures first. V2 has its own database migration behavior; do not let an experimental server open production state just because its code lives in another directory. [S3]

10. Delivery slices and acceptance gates

Slice A — Baseline and architecture spike

Verify the pinned source builds. Add the base manifest and disposable development configuration. Prove a native Watch target survives clean Expo regeneration. On a paired physical Watch/iPhone, prove system dictation returns reviewable text and prove native phone message handling after backgrounding.

Exit: signed development builds install; no assumed API/platform availability remains in the critical path.

Slice B — Narrow server boundary

Implement authorized compact reads, strict command admission, receipt lookup, and any minimal transaction-safe metadata/precondition extension. Use real V2 test infrastructure; test start, native steer, queue, and explicitly authorized restart without Watch hardware.

Exit: no new queue or orchestration database; duplicate and cross-target tests pass.

Slice C — Usable voice loop

Implement pins/recent threads, immutable target, dictation review, available actions, direct HTTPS, durable local submission state, and receipt-backed feedback. Include at least one verified real provider/session supporting native steering, plus queue behavior.

Exit: a dictated redirect affects the chosen running thread and is visible in the normal T3 client; retrying it produces no second admitted instruction.

Slice D — Phone relay and multi-environment reliability

Add native phone setup and HTTP forwarding with the Watch credential; test direct/relay handoff, private endpoints, process suspension, stale snapshots, expired requests, and revoked sessions.

Exit: direct and relayed delivery of the same command converge on the same receipt; unsupported routes fail visibly without misrouting or silently delayed steering.

Slice E — Daily-use polish

Add complication launch, accessibility, refined haptics, optional Stop using fully verified upstream semantics, and privacy controls. Add notifications only when their transport and delivery behavior are independently verified. Native recording/transcription and completely phone-free enrollment remain later enhancements.

Required test matrix

• Idle thread: voice creates one intended follow-up, retaining thread and provider configuration.
• Busy thread: native steer targets the exact active run; Queue remains queued on the server.
• Provider requiring restart: ordinary native Steer cannot silently trigger it; explicit Interrupt & redirect can when supported.
• Tool-disruptive native steering: warning/authorization is enforced according to actual capabilities.
• Race: run finishes, new run starts, or provider changes while dictating; draft remains and no unintended run is targeted.
• Duplicate: repeated taps, lost HTTP reply, phone timeout, and direct/relay races converge on one command receipt.
• Conflict: same command ID with changed text, action, target, or principal cannot produce new side effects or expose another receipt.
• Restart/crash: acceptance followed by process loss is reconciled honestly; uncertain provider effects are not blindly replayed.
• Offline/expiry: drafts survive; expired run-targeted instructions are not newly dispatched; existing receipts remain queryable.
• Auth: revoked Watch session fails new operations; the bridge cannot upgrade its authority; generic RPC rejects restricted Watch sessions.
• Multi-environment: duplicate project names and thread titles cannot cross-route; one offline environment does not stall the rest.
• Native subagent: read-only thread does not receive a message intended for its parent.
• Lifecycle: lock, wrist drop, app kill, phone background, phone reboot/unlock requirement, phone absent, and network transitions show correct pending/unknown state.
• Build: two clean prebuilds preserve targets and produce no duplicate configuration; Linux/server tests remain green.

Measure dictation-to-review latency, confirm-to-commit acknowledgment, reconnection frequency, duplicate rejection, and expired/stale-target rejection. Report actual p50/p95 on representative direct and relayed routes; do not promise a sub-second cellular result without measurements.

11. Evidence and unresolved validation

The release tag, current mobile package, V2 dispatch policy, receipt store, capability fields, and key auth/architecture documentation were read. This is enough to replace the stale-fork assumptions and choose the implementation boundary.

No Swift target was compiled, no Watch was exercised, and no server adapter was implemented in this research. The exact dispatch precondition hook, byte-level command fingerprint behavior, compact projection service call, and generic-route enforcement for a proposed Watch audience require implementation-level tracing and tests. Those are explicit Slice A/B tasks, not features claimed to exist upstream.

Sources

All repository source links below are pinned unless a live release/issue is the subject.

• S1 — Live upstream releases: https://api.github.com/repos/pingdotgg/t3code/releases?per_page=5
• S2 — Resolved baseline tag: https://api.github.com/repos/pingdotgg/t3code/git/ref/tags/v0.0.46-nightly.20261010.2948
• S3 — Official V1-to-V2 migration announcement: https://github.com/pingdotgg/t3code/issues/14871
• S4 — Mobile package: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/apps/mobile/package.json
• S5 — Architecture: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/docs/internals/overview.md
• S6 — V2 contracts: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/packages/contracts/src/orchestrationV2.ts
• S7 — Actual dispatch policy: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/apps/server/src/orchestration-v2/CommandPolicy.ts
• S8 — Orchestrator integration: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/apps/server/src/orchestration-v2/Orchestrator.ts
• S9 — Existing command receipts: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/apps/server/src/orchestration-v2/CommandReceiptStore.ts
• S10 — Environment authentication: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/docs/internals/environment-auth.md
• S11 — Lifecycle design document, explicitly target behavior: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/docs/orchestration-v2/feature-lifecycles.md
• S12 — Earlier Live Activities PR, closed unmerged: https://github.com/pingdotgg/t3code/pull/4978
• S13 — Apple system Watch text input: https://developer.apple.com/documentation/watchkit/wkinterfacecontroller/presenttextinputcontroller(withsuggestions:allowedinputmode:completion:)
• S14 — SwiftUI text input: https://developer.apple.com/documentation/swiftui/text-input-and-output
• S15 — Apple networking guidance: https://developer.apple.com/documentation/technotes/tn3151-choosing-the-right-networking-api
• S16 — watchOS application and network lifecycle: https://developer.apple.com/documentation/watchos-apps
• S17 — WatchConnectivity semantics: https://developer.apple.com/documentation/watchconnectivity/wcsession
• S18 — Background tasks: https://developer.apple.com/documentation/watchkit/using-background-tasks
• S19 — Expo clean prebuild and native generation: https://docs.expo.dev/workflow/continuous-native-generation/
• S20 — Upstream workflow and project README: https://github.com/pingdotgg/t3code/blob/4f63275ac7885281d245022e65f1e9e8816b1382/README.md
