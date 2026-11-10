# MCP servers

Add a remote MCP server, such as Executor, to an environment once, and agents
in that environment's Full access threads can use its tools. You don't have to
configure it in each provider. Claude, Codex, Cursor, OpenCode, Pi, Muse, and
the ACP agents (Grok, Antigravity, fx, and Registry agents) all get it.

## Add a server

Open **Settings → MCP servers** and choose **Add server**. On mobile, open the
environment in **Settings** and choose **MCP servers**.

- **Name** identifies the server. Agents see it with a `shared-` prefix, for
  example `shared-executor`, so it doesn't clash with servers you configured in
  a provider yourself, unless you named one of those `shared-…` too. Use
  lowercase letters, digits, and dashes. Names starting with `t3` are reserved.
- **URL** is the server's streamable HTTP endpoint, such as
  `https://executor.example.com/mcp`. Anyone who can view this environment's
  settings sees it, so put credentials in the token, not the URL.
- **Bearer token** is optional. It is stored on the environment and never sent
  to agents or other devices. It is only ever sent to the URL it was saved
  with: changing the URL removes it, so enter it again for the new address.

**Test** connects the way an agent would and lists the server's tools. Adding,
changing, or removing servers through Settings or WebSocket clients needs permission
to manage providers. Full-access agents can also manage shared servers through the
`t3_mcp_server_*` tools.

## How agents use it

- Only threads with **Full access** get these tools. In other modes agents
  don't see them, because an agent that can run commands could otherwise call
  the server without asking you. After switching a thread to Full access, use
  **Restart agent**.
- Added or re-enabled servers reach new agent sessions only; use **Restart
  agent** to pick them up. URL and token changes apply immediately.
- Agents connect through the environment, which adds the saved token. Turning a
  server off, removing it, or taking a thread out of Full access stops access
  immediately, even for running sessions.
- Once a server is added here, Codex through ACP asks before T3 Code's own
  tools outside Full access, because it doesn't say which server a call is for.
- If the server is unreachable, takes more than 5 seconds to connect or list
  its tools, or rejects its token, its tools fail with a message saying so and
  the chat carries on. Failed calls are not retried, so a call that may have
  run is never repeated.

## Moving from per-provider setup

If you already added the same server to a provider, for example with
`claude mcp add` or in `~/.codex/config.toml`, remove that entry. Otherwise
agents see every tool twice.

## Not supported

- Servers that run as a local command (stdio). Only HTTP servers can be added.
- Servers that need an OAuth sign-in. Use a bearer token instead.
