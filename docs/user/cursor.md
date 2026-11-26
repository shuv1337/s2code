# Cursor

Run Cursor's local agent in S2Code using your paid Cursor account or `CURSOR_API_KEY`.

## Prerequisites and sign-in

- **Node.js 22.13+** on the environment's machine.
- A **paid Cursor plan** via browser sign-in or `CURSOR_API_KEY`.
- Open **Settings → Providers → Cursor** and choose **Sign in** (works on remote environments and configured mobile instances too).

Each Cursor instance keeps its own login separate from your Cursor editor or CLI. A configured `CURSOR_API_KEY` overrides browser sign-in. **Change account** or **Sign out** stops running threads for that instance while keeping history (to revoke a key early, delete it in your Cursor dashboard).

## Capabilities and limits

- Supports streaming text, reasoning, tool activity, plans, image attachments, mid-turn text steering (steers with attachments or mode changes restart the run), and **Edit from here** / checkpoint rewind (rewinding to the first message starts a fresh session).
- **Subagents**: Cursor `task` subagents appear as read-only child threads; message the parent thread to interact.
- **Forking**: Uses a [portable handoff](./portable-handoffs.md) into a fresh Cursor session.
- **Cloud agents**: Not yet supported—runs operate locally in your S2Code workspace.
- **Permissions**: **Full access** disables Cursor's sandbox; restricted modes enable it. On Windows, the Cursor SDK has no filesystem sandbox, so **Auto** and **Supervised** run without filesystem isolation when Cursor Auto-review is enabled, while **Auto-accept edits** cannot start on Windows.

## MCP servers and plugins

Cursor loads MCP servers and plugins from `~/.cursor/mcp.json`, `~/.cursor/plugins`, and (in **Full access** only) the project's `.cursor/mcp.json`.

For OAuth MCP servers, authenticate via the CLI from the project root before starting a session:

```bash
agent mcp login <server>
```

After adding or changing skills, plugins, or MCP logins, run **Restart agent session** from the command palette.

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
