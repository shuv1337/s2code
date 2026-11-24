# Telemetry and data flows

S2Code sends no background product analytics, account or install fingerprints, relay connection
traces, or mobile crash reports. No environment variable, build variable, or managed policy can
turn any of them back on.

## What was removed

| Mechanism                                   | Status in S2Code                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product usage analytics (PostHog)           | Removed. `AnalyticsService` is a zero-requirement no-op.                                                                                                                                                                                                |
| Install, account, and device fingerprinting | Removed. The server never creates `anonymous-id` or reads `~/.codex/auth.json`, `~/.claude.json`, or S2 Connect secrets for analytics. Clients never generate `t3code:analytics-device-id` or send `clientOwner` / `clientDevice` WebSocket parameters. |
| Relay client tracing (Axiom / OTLP)         | Removed across server, desktop, web, and mobile. `RelayTracing.layer` always returns no tracer and `isRelayTracingEnabled` always returns `false`.                                                                                                      |
| Mobile crash reporting (`expo-observe`)     | Removed from dependencies and app config. Nothing dispatches crash reports or startup timings off-device.                                                                                                                                               |

## What leaves your machine only when you turn it on

### Agent feedback

Agent feedback lets agents report S2Code issues: a tool or `t3` command that did not do what they
expected, a confusing instruction, or a missing capability. Choose a mode in **Agent feedback** in
**Settings > Labs**:

- **Off**, the default: agents do not see the feedback tools, and `t3 feedback` stops with a
  message pointing to Labs.
- **When I ask**: agents send a report only when you ask them to, about anything in S2Code.
- **Automatic**: agents also report S2Code problems they hit on their own, such as a tool that
  failed and made them find another way. These reports carry no outline and no message text, and
  go out without asking you. `t3 feedback --kind bug --subject "t3 thread send" --expected "…" --actual "…"`
  sends one the same way, so it works only in this mode.

When you ask your agent for a report, in either mode, S2Code shows it in the thread as a card
with exactly what would leave your machine, and sends it only if you press **Send**. The agent
carries on without waiting and never learns your answer. The card stays open until you answer it,
even after the turn ends or the server restarts; **Don't send** sends nothing, and the agent is
told not to send it another way. Only someone who can run agents on that machine can answer the
card; people on a guest link cannot.

Each report has the kind of problem, the tool or command it concerns (or `general`), and up to
300 characters each of expected behavior, actual behavior, and workaround, written by the agent,
which is told not to quote your messages or code. The agent also says how many recent turns the
problem spans. A report you approved carries an outline of those turns, and of at least the last 5,
from when the agent asked: who spoke, how long each message was, and which tools ran, whether they
worked, and how long they took. The outline has no text. Tools from your other MCP servers appear
only as `mcp`. Turn on **Include the conversation** in the card to attach the text of your
messages and the agent's replies in the turns the problem spans, up to 1,000 characters per
message and 16 KB in all, oldest text dropped first; the card shows that text before you send it.
To change a report, such as the turns it covers, ask the agent in the chat: it shows a new card,
and you can decline the old one. Tool inputs and outputs, files, and attachments are never sent. An agent can
show you at most 3 report cards and send 3 reports on its own per turn, and `t3 feedback` can
send at most 10 an hour.

Before anything is saved, S2Code removes file paths (when text mentions one, the rest of that line
goes with it), your user name, machine name, project title, branch, and git remote, and anything
that looks like a key, token, email address, or URL with a password. It cannot recognise your code
or a name written in a sentence, so only include the conversation when it holds nothing you would
not send. Reports from agents also name the provider, model, server version, release channel, OS,
architecture, and mode. No thread IDs, project IDs, or install IDs are sent.

Reports are saved on your machine first, and a declined one is not saved at all; its card keeps
only what you would have sent without the conversation. When your host is linked to S2 Connect,
approved and automatic reports are delivered to the S2 Connect relay (`POST /v1/feedback`) and stored
privately in its Postgres database. For user-approved reports, the relay also files a public GitHub
issue on `shuv1337/s2code` containing only the scrubbed `expected`, `actual`, and `workaround`
fields, metadata (including model ID, provider, version, channel, OS, architecture, and mode), and
structural trace outline—never conversation turn text, environment IDs, IPs, or user IDs. Unlinked
hosts, servers started with `S2CODE_TELEMETRY_ENABLED=false` (or `0`/`off`/`no`), or servers where
[managed policy](./managed-policy.md#other-capabilities) disables `telemetry` keep saved reports
locally without sending them. `t3 feedback list` shows recent reports, the thread each came from,
and a line for each outline; `t3 feedback list --json` shows exactly what each one holds.

### Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver you control, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. Nothing is exported until you configure an endpoint.

The receiver must be reachable from the server's machine. **Test** sends an empty export from the
server to check an endpoint before or after you save it; saved endpoints are checked when the
section opens. Checks send authentication headers only to the signal's currently running endpoint
and do not follow redirects. To check a new endpoint that requires authentication, save it and
restart the server first.

`S2CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with
`S2CODE_OTLP_*_URL`, set `S2CODE_OTLP_HEADERS` for receivers that need authentication and
`S2CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do not accept JSON. An endpoint set with
`OTEL_EXPORTER_OTLP_*` takes its headers and protocol from `OTEL_EXPORTER_OTLP_HEADERS` and
`OTEL_EXPORTER_OTLP_PROTOCOL` instead.

### Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the S2 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). To stop publishing, turn off
**Publish agent activity** under **Settings > Sharing & access** on the host. Turning off
notifications on a phone controls that phone's alerts, not the host's publishing setting.

### S2 Connect linking

When you explicitly link a machine to S2 Connect, the server authenticates with the configured fork
relay to establish remote tunnel credentials and session routing. Direct LAN and Tailscale
connections do not contact the relay.

## Network calls S2Code still makes to operate

- **Your configured AI providers and MCP servers:** Prompts, code, and tool traffic go directly from
  your machine to the provider CLIs, APIs, and MCP servers you configure.
- **Release and update checks:** Desktop and CLI builds check GitHub Releases for `shuv1337/s2code`
  (or your configured update repository) and npm metadata when checking for updates, unless disabled
  with `S2CODE_DISABLE_AUTO_UPDATE` or managed policy.

## Local-only diagnostics

- **Resource Monitor:** CPU, memory, and process metrics stay between the local desktop shell,
  server, and UI; nothing is sent off-machine.
- **Mobile startup crash log:** **Settings > About > Diagnostics** reads `expo-updates` startup
  crash entries stored on the device for 7 days and lets you manually **Copy crash report** to
  paste into an issue. Nothing is uploaded automatically.

## Legacy telemetry variables

- Setting `S2CODE_TELEMETRY_ENABLED=true`, `S2CODE_POSTHOG_HOST`, or `S2CODE_POSTHOG_KEY` does
  nothing. Background analytics and relay tracing cannot be re-enabled.
- Setting `S2CODE_TELEMETRY_ENABLED=false` (or a managed policy with `limits.telemetry: false`)
  remains supported as an explicit kill switch that blocks opt-in **Agent feedback** delivery.
