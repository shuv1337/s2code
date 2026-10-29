# s2 voice orchestrator (FM-S2-SPIKE-1 / #337)

Thin GPT-Live client on the hub. Speech (or text dry-run) → allowlisted `t3_*`
tools on the local s2code HTTP MCP. Destructive tools are never on the
allowlist. Side-effecting allowlisted calls announce the target environment
name before running. Every tool call is audited to ndjson (no args/secrets).

## Config (outside the repo)

Copy `config.example/config.json` to e.g. `~/.config/s2-voice/config.json`
(or set `S2_VOICE_CONFIG`). Never commit hostnames, tokens, or API keys.

```bash
export S2_VOICE_CONFIG="$HOME/.config/s2-voice/config.json"
# OpenAI key via 2password — never plain on disk if you can avoid it:
2password run --env "OPENAI_API_KEY=op://…/credential" -- \
  pnpm --filter @t3tools/voice start
```

Env overrides: `OPENAI_API_KEY`, `S2_VOICE_MCP_URL`, `S2_VOICE_MCP_TOKEN`,
`S2_VOICE_AUDIT_DIR`, `S2_VOICE_MODE` (`live` | `text-dry-run`).

## Modes

- `live` — GPT-Live WebSocket (`gpt-live-1`) with Responses delegation; tools
  execute locally against the hub MCP.
- `text-dry-run` — no audio; inject a canned function_call and exercise the
  tool bridge (mock MCP by default).

## Cap: run on shuvdev (separate install step)

1. Put OpenAI API key in 1Password Shared vault; wire via `2password run`.
2. Write `~/.config/s2-voice/config.json` with hub MCP URL + token (private
   path only; no public origin).
3. Checkout `spike/s2-voice-orchestrator` (or install a built artifact) on
   shuvdev only — do not install the audit patch onto nightly until Cap says.
4. `pnpm --filter @t3tools/voice start` under the config + key env.
5. Confirm spoken env announcement + `voice-tool.ndjson` lines before any
   peer side effects.
