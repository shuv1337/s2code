# Cursor

Cursor V2 runs through the official [`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript)
TypeScript package. It does not use Cursor's ACP transport for V2 execution.

## Prerequisites

- Node.js 22.13 or newer. The repository's supported Node version satisfies this requirement.
- Sign in with Cursor in **Settings > Providers > Cursor**, or provide a Cursor API key in
  `CURSOR_API_KEY`.
- A paid Cursor plan on the account used for browser sign-in or `CURSOR_API_KEY`.
- A model accepted by the Cursor SDK. `auto` is sent to the SDK as its `default` model selection.

The adapter currently uses the SDK's local-agent runtime so runs operate in the selected S2Code
workspace. Cursor cloud agents need repository and cloud-environment configuration that S2Code does
not expose yet.

Custom Cursor MCP servers and plugins are not configured in T3 Code. They load from the environment
machine's Cursor config when the agent opens: project `.cursor/mcp.json`, user `~/.cursor/mcp.json`,
and installed plugins under `~/.cursor/plugins`. Plugin tools
can appear without a login; OAuth MCP servers still need credentials. Run `agent mcp login <server>`
with the cwd set to the T3 project root (tokens land in
`~/.cursor/projects/<folder-slug>/mcp-auth.json`). Cursor desktop Connections auth does not write
that file, and the local SDK cannot complete interactive MCP OAuth itself—auth attempts fail with
messages such as "MCP authentication is not supported in local SDK runs" or that the auth server
does not support dynamic client registration. After you add or change skills, plugins, or MCP
servers, or after a successful CLI login, use **Restart agent session**.

## Sign in

Choose **Sign in**, then open the sign-in page and complete it in your browser. S2Code
updates automatically when sign-in finishes. This works when connected to a remote environment too.
On mobile, use **Settings > Providers** for an already configured Cursor instance.

Each provider instance keeps its own login on the environment that runs it. Your Cursor editor and
CLI login are separate. A configured `CURSOR_API_KEY` overrides browser sign-in; remove that override
to use the browser flow.

Use **Change account** or **Sign out** in the same settings section. Both stop that
instance's running threads and keep their history. Sign-out forgets the saved credential; to revoke
the generated key before it expires, remove it from your Cursor dashboard's API keys.

## Several accounts

Add one Cursor instance per account. **Usage → Limits** shows each enabled account's monthly
usage and reset date. A meter at 100% does not always mean the account is blocked: Cursor can still
run Auto after the named-model allowance is spent.

To pool accounts, turn on **Turn off at usage limit** for each account. Once two accounts have it
on, the model picker shows them as one **Cursor pool** entry. Each new thread starts on the account
with the most headroom for its model and stays there. [Pool accounts](./usage.md#pool-accounts)
covers how ties take turns and what happens when an agent names one account.
When a turn fails because that account's
quota is spent, S2Code turns the instance off, notes when and why, and continues the thread on the
pool account with the most headroom. The new account starts a fresh Cursor session and receives the recent conversation, so expect
it to re-read context once. A thread switches automatically only once per message; if the next account
also runs out, the thread stops so you can choose. Messages sent later to a turned-off account go to
a healthy one. Short rate limits do not count, and accounts you turned off yourself are left alone.
Turn an instance back on yourself after its quota resets.

With **Linked environments** on in **Settings → Labs** on both machines and a full-access link
between them, linked machines share which pool accounts are spent. An account turned off at its
usage limit on one machine is also turned off in the other machine's pool, and turning it back on
on either machine turns it back on on the other. While the account is still spent, a pool instance
you add, turn on, or sign in to it later is turned off too. Turn it on again to keep it on, which
also marks the account available on the linked machines. A change on the
machine you linked to can take about a minute to arrive. Only machines linked to each other share:
a machine does not pass on what it learned from a third. When the provider reports when a quota
resets, the account stops counting as spent on the other machines after that time. Accounts are
matched by the signed-in account, so the instances do not need the same names. Accounts you turned
off yourself stay as they are, and an account without a known email, such as some API keys, is not
shared.

## V2 Capability Mapping

The adapter supports:

- creating and resuming local Cursor agent threads;
- changing the model and model parameters between turns;
- assistant text, reasoning, tool activity, plans, and todo streaming;
- thread-scoped S2Code MCP tools alongside ambient Cursor MCP/plugins from disk;
- image attachments;
- interruption, queued app messages, and orchestrator-owned interrupt/restart steering;
- provider conversation snapshots through `Agent.messages.list()`;
- Cursor `task` subagents, projected as read-only child app threads with their tool activity and
  final result.

The public SDK does not currently expose native agent fork, conversation rollback, active steering,
or interactive approval callbacks. Direct active steering is advertised as unsupported, while V2
steering uses the orchestrator's interrupt-and-restart path and preserves the app run identity across
provider turns. Same-provider Cursor forks use the orchestrator's portable full-thread context
handoff into a fresh Cursor agent. The SDK has in-process custom callback tools, but the V2 adapter
intentionally uses the authenticated, thread-scoped MCP server instead.

Portable handoffs summarize eligible timeline items and can omit the end of long messages. Read
[Context in portable handoffs](./portable-handoffs.md) before using a fork for work whose exact
instructions must carry forward.

Cursor task events include an `agentId`, but the local SDK does not register that identifier as a
resumable agent: `Agent.resume()` returns `AgentNotFoundError`. The adapter therefore does not attach
a provider thread to native task projections or advertise subagent thread IDs. A projected child is
read-only: send messages from the parent thread.

Runtime modes map to the controls the local SDK exposes: full access disables its sandbox, while
restricted modes normally enable it. On Windows, Auto and Supervised run without filesystem
isolation when Cursor Auto-review is enabled, because the SDK does not support a filesystem sandbox
there. Restricted modes without Auto-review, including the default Auto-accept edits mode, still
request the sandbox and cannot start on Windows. Explicit sandbox policies remain authoritative,
including restrictive policies that the Windows SDK rejects. Explicit approval policy overrides
control Auto-review, which is not represented as an interactive S2Code approval flow.

The existing Cursor binary path and API endpoint settings belong to the CLI/ACP integration. Cursor
V2 execution does not launch that binary, and the SDK does not expose an API endpoint override.

## Replay And Live Testing

Cursor replay fixtures preserve the SDK boundary: agent open/resume, sends, ordered `onDelta`
updates, terminal results, cancellation, message snapshots, and close. The real V2 adapter,
orchestrator, event store, projections, and checkpoint logic still run in tests.

Record a fixture against the real SDK with:

```bash
pnpm --filter t3 record:cursor-replay --scenario simple
```

Use `--out <path>` to record a temporary probe without replacing a checked-in fixture. Supported
scenarios are listed by the recorder when an invalid scenario is supplied.
