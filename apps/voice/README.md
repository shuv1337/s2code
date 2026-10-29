# s2 voice orchestrator (FM-S2-SPIKE-1 / #337)

Thin GPT-Live client on the hub. Speech (or a text dry-run) calls allowlisted
`t3_*` tools on the hub s2code MCP. Peers such as shuvbot are reached with
`environmentId` from `t3_environment_links`; this process holds one hub
credential. Side effects say `On <environment>.` first. Guarded tools (workflow stop, transfer, handoff, project create/clone,
environment link/unlink, preview list/close) run only after a spoken yes
that names the target ids. The prompt stays open for 20 seconds. A second
guarded call is rejected while one is waiting, and a yes after that window
does not apply. `t3_project_delete` stays blocked. `t3_thread_send` with `mode: restart` and
`t3_queue` with `action: cancel` also wait for a spoken yes. The yes applies
only to the arguments captured when the model called the tool. A later yes
cannot change the thread, message, or mode. Every tool call is audited to
ndjson with no args or secrets. The voice client retries a lost MCP session
only on HTTP 404, and send, launch, and pending respond reuse the GPT-Live
`call_id` as `clientRequestId`.

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
`S2_VOICE_AUDIT_DIR`, `S2_VOICE_MODE` (`live` | `text-dry-run`).

## Modes

- `live` — GPT-Live WebSocket at `wss://api.openai.com/v1/live/sessions`
  (`session.start`, model `gpt-live-1`, Responses delegation). Tools run
  against the hub MCP. Announcements also go out as
  `session.commentary.append`. Spoken yes/no for a guarded tool is read from
  `session.input_transcript.delta`. Microphone capture is not wired;
  `appendAudio` accepts 24 kHz PCM16 when a capture process is attached.
- `text-dry-run` — no audio. Requires `S2_VOICE_MCP_URL` or `--mock-mcp`.
  `--mock-mcp` is only for offline checks.

```bash
pnpm --filter @t3tools/voice dry-run
```

## Cap: run on shuvdev (separate install step)

1. Put the OpenAI API key in 1Password and inject it with `op run`. Do not
   print the key.
2. Write `~/.config/s2-voice/config.json` with the hub MCP URL and token
   (private path only; no public origin). Use the narrowest hub credential
   that can call the exact tool names in the voice allowlist and the guarded
   list. The client denies every other name. This spike does not add a
   server-side deny list for that credential.
3. Checkout `spike/s2-voice-orchestrator` on shuvdev only.
4. `pnpm --filter @t3tools/voice start` under the config + key env.
5. Confirm spoken env announcement + `voice-tool.ndjson` lines before any
   peer side effects.
