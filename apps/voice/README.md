# s2 voice orchestrator (FM-S2-SPIKE-1 / #337)

Thin GPT-Live client on the hub. Speech (or a text dry-run) calls allowlisted
`t3_*` tools on the hub s2code MCP. This process holds one hub credential.
Peers such as shuvbot are reached only by passing that peer's `environmentId`
from `t3_environment_links`. Omit `environmentId` on discovery tools
(`t3_environment_read`, `t3_environment_links`, project list/read, thread
list/search/read, worktree list) and the hub answers. `t3_environment_links`,
`t3_worktree_status`, `t3_background_wait`, `t3_worktree_handoff`, and the
preview tools do not accept `environmentId`; the client strips it so the hub
does not return `Expected never`. A `tools/list` input schema overrides this
static map when the hub is reachable.

`defaultEnvironmentId` is copied only onto action tools that accept a target
(`t3_thread_launch`, `t3_thread_send`, interrupt, update, configure, queue,
pending request, and guarded tools that route). It is not applied to discovery.
If that default is a peer, an action that omits `environmentId` runs on the
peer. Set it to the hub id, or leave it unset, to keep those actions on the
hub too. `t3_environment_link` / `t3_environment_unlink` use `environmentId`
as the machine to link or forget, so the client never fills it in.

Side effects say `On <environment>.` first. Guarded tools (workflow stop, transfer, handoff, project create/clone,
environment link/unlink, preview list/close) run only after a spoken yes
that names the target ids. The prompt stays open for 20 seconds. A second
guarded call is rejected while one is waiting, and a yes after that window
does not apply. `t3_project_delete` stays blocked. `t3_thread_send` with `mode: restart` and
`t3_queue` with `action: cancel` also wait for a spoken yes. The yes applies
only to the arguments captured when the model called the tool. A later yes
cannot change the thread, message, or mode. Every tool call is audited to
ndjson with no args or secrets. The voice client retries a lost MCP session
only on HTTP 404. Send, launch, interrupt, update, and environment link
overwrite `clientRequestId` with the GPT-Live `call_id`. `t3_pending_request`
does not accept that key, so the client does not send it.

Discovery results are shortened to ids, labels, and status before the model
sees them. Other results are capped (`toolResultMaxChars`, default 4000,
`S2_VOICE_TOOL_RESULT_MAX_CHARS`). Token, secret, and password fields are
redacted. `t3_thread_list` requires `projectId` because this client is not
inside a thread.

`t3_thread_send` and `t3_thread_launch` return immediately. A second poll of
`t3_thread_wait` speaks a one-line summary when the run settles.
`t3_pending_request` answers user questions. It cannot approve a permission
request; those still resolve in the s2code UI.

## Accepted risks (spike only)

Recorded on issue 337. Do not treat them as blockers for this branch, and
re-pair shuvbot to `approval-required` before any longer-lived use.

- Full-access shuvdev → shuvbot means a voice session can steer shuvbot,
  including through allowlisted unconfirmed `t3_thread_launch` /
  `t3_thread_send` if a thread is prompt-injected.
- `t3_thread_read` content is sent to OpenAI so the model can speak it.

## Cost

GPT-Live voice time is published at $0.05 per minute, billed per second
($3.00 per hour) before backend tokens. At $200 of monthly credits the
voice-only ceiling is about 66.7 hours. Tool use spends that faster; plan on
roughly 30–60 hours. Credits expire monthly. `session.closed` carries
`usage.seconds` for a measured session. A local Parakeet (speech-to-text) plus
Kokoro (text-to-speech) path is the later always-on option: same tool bridge,
audio stays on the machine, API cost is text tokens only.

## Config (outside the repo)

Copy `config.example/config.json` to e.g. `~/.config/s2-voice/config.json`
(or set `S2_VOICE_CONFIG`). Never commit hostnames, tokens, or API keys.

```bash
export S2_VOICE_CONFIG="$HOME/.config/s2-voice/config.json"
# OpenAI key via 1Password. Never print or commit it.
op run --env-file .env.op -- \
  pnpm --filter @t3tools/voice start
```

Env overrides: `OPENAI_API_KEY`, `S2_VOICE_MCP_URL`, `S2_VOICE_MCP_TOKEN`,
`S2_VOICE_AUDIT_DIR`, `S2_VOICE_MODE` (`live` | `text-dry-run`),
`S2_VOICE_TOOL_RESULT_MAX_CHARS`.

## Modes

- `live` — GPT-Live WebSocket at `wss://api.openai.com/v1/live/sessions`
  (`session.start`, model `gpt-live-1`, Responses delegation). Tools run
  against the hub MCP. Announcements also go out as
  `session.commentary.append`. Spoken yes/no for a guarded tool is read from
  `session.input_transcript.delta`. Microphone capture is not wired;
  `appendAudio` accepts 24 kHz PCM16 when a capture process is attached.
- `text-dry-run` — no audio. Requires `S2_VOICE_MCP_URL` or `--mock-mcp`.
  `--mock-mcp` is only for offline checks. `--project-id <id>` is passed to
  `t3_thread_list`. Without it, the run calls `t3_project_list` and uses the
  first project. If that list is empty or fails, thread list is skipped and
  the process still prints a JSON report. `--mock-mcp` with no flag uses
  `project-dry-run`.

```bash
pnpm --filter @t3tools/voice dry-run
# against a hub:
# s2-voice --mode text-dry-run --project-id <projectId>
```

## Cap: run on shuvdev (separate install step)

1. Put the OpenAI API key in 1Password and inject it with `op run`. Do not
   print the key.
2. Write `~/.config/s2-voice/config.json` with the hub MCP URL and token
   (private path only; no public origin). Use the narrowest hub credential
   that can call the exact tool names in the voice allowlist and the guarded
   list. The client denies every other name. This spike does not add a
   server-side deny list for that credential.
3. Checkout `main` (`apps/voice`) on shuvdev only.
4. `pnpm --filter @t3tools/voice start` under the config + key env.
5. Confirm spoken env announcement + `voice-tool.ndjson` lines before any
   peer side effects.

## iOS sketch

Not implemented. This spike stays a Node process on the hub host.

**Tool bridge.** `apps/voice` is a Node CLI (`ws`, filesystem audit, `fetch`).
Do not import it from React Native. The rules worth sharing are pure: the
allowlist, which tools accept `environmentId`, spoken confirmation, and the
short discovery summaries. When a second client is real, move those into
`packages/client-runtime` (or a tiny shared package) so iOS and this CLI
cannot drift. Until then, an iOS experiment should call the hub MCP itself
with the same rules, not shell out to `s2-voice`.

**Microphone.** Capture with `AVAudioEngine` at 24 kHz mono PCM16, the format
`appendAudio` already sends as `session.input_audio.append`. Use a
play-and-record session and voice processing. This spike does not open a
microphone; iOS would be the first real capture path. Playback of model audio
is a separate tap on that session. The app's existing dictation path
([voice input](../../docs/internals/voice-input.md)) edits a composer draft
and does not talk to GPT-Live.

**Auth.** Use the environment session the mobile app already pairs, or the
MCP OAuth flow an outside agent uses (Settings → Environments → Copy MCP URL,
then the environment's existing sign-in). The bearer is that paired
mcp-client token. Do not add a second token file, and do not ship
`OPENAI_API_KEY` in the app. `S2_VOICE_MCP_TOKEN` on the desktop spike is the
host stand-in for that paired client.

**Hub URL.** The user enters the hub the same way they add an environment.
Voice calls `{origin}/mcp` on that hub only. A peer is an `environmentId`
argument, not a second socket. Omit `environmentId` on discovery tools to
stay on the hub; pass an id from `t3_environment_links` to target that peer.

**Stays on the desktop spike.** The GPT-Live WebSocket and the OpenAI key
(`op run` / `OPENAI_API_KEY`), the text dry-run CLI, `--mock-mcp`, and the
ndjson audit directory. No server-side tool allowlist. Spoken yes/no can
wait until capture exists. iOS does not need a port of the CLI flags.
