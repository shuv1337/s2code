# MCP servers

Add a remote MCP server, such as Executor, to an environment once, and every
agent that environment starts can use its tools. You don't have to configure it
in each provider. Claude, Codex, Cursor, OpenCode, Pi, Muse, and the ACP agents
(Grok, Antigravity, fx, and Registry agents) all get it.

## Add a server

Open **Settings → MCP servers** and choose **Add server**. On mobile, open the
environment in **Settings** and choose **MCP servers**.

- **Name** identifies the server. Agents see it with a `shared-` prefix, for
  example `shared-executor`, so it never replaces a server you configured in a
  provider yourself. Use lowercase letters, digits, and dashes. Names starting
  with `t3` are reserved.
- **URL** is the server's streamable HTTP endpoint, such as
  `https://executor.example.com/mcp`.
- **Bearer token** is optional. It is stored on the environment and never sent
  to agents or other devices. It is only ever sent to the URL it was saved
  with: changing the URL removes it, so enter it again for the new address.

**Test connection** connects the way an agent would and lists the server's
tools. Adding, changing, or removing servers needs permission to manage
providers.

## How agents use it

- New agent sessions get the current list. A running session keeps the servers
  it started with, so use **Restart agent** after a change.
- Agents connect through the environment, which adds the saved token. Turning a
  server off or removing it stops access immediately, even for running
  sessions.
- These tools follow your permission mode, like a server you configured in the
  provider yourself. The automatic approval T3 Code gives its own tools does not
  extend to them. With Codex through ACP, any MCP tool call asks first outside
  full access once a server is added here, because Codex doesn't say which
  server a call is for.
- If the server is unreachable or rejects its token, the tool call fails with a
  message saying so and the chat carries on. Failed calls are not retried, so a
  call that may have run is never repeated.

## Moving from per-provider setup

If you already added the same server to a provider, for example with
`claude mcp add` or in `~/.codex/config.toml`, remove that entry. Otherwise
agents see every tool twice.

## Not supported

- Servers that run as a local command (stdio). Only HTTP servers can be added.
- Servers that need an OAuth sign-in. Use a bearer token instead.
