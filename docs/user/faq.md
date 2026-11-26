# FAQ

## Is S2Code a harness?

No. A harness turns an LLM into an agent (tools, execution loop, and results)—like Claude Code's Agent SDK or Codex App Server. S2Code drives those harnesses through one fast interface; it does not work without at least one installed agent.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, fx, or any [ACP agent](./providers-acp.md). See [Provider setup](./install.md#providers). (Longer read: [What is a harness?](https://t3.gg/blog/post/what-is-a-harness))

## Why use S2Code instead of Claude Code or the Codex app?

- **Bring your own subscription**: Use Claude, Codex, and every other agent you already have installed in one place.
- **Remote-first**: Run `s2code-nightly up` on the host and drive it from your other devices.
- **Mobile access**: Approve steps, review PRs, and steer threads from the iOS TestFlight beta or a mobile browser.
- **Open source (MIT)**: Fork the source code under your own branding if you ever want something different.

## Can I use S2Code with my Claude Code subscription?

Yes.

## How much does S2Code cost?

S2Code is free. You pay your model providers directly. LAN, Tailscale, and desktop-managed SSH do not require a hosted account. S2 Connect requires a separately configured fork relay.

## Can I fork or redistribute S2Code?

Yes. The source code is available under the [MIT License](../../LICENSE). S2Code is an independent fork, not an official T3 Code build.

## Why is my Claude 5-hour limit draining so fast?

Since v0.1.7, Claude in S2Code drains your 5-hour limit at the same rate as Claude Code directly (an earlier Anthropic Agent SDK discrepancy has been resolved). If you still see it, [update S2Code](./updating.md) on the machine running your agents.

## How do I use S2Code remotely?

Your agents run wherever the S2Code server runs (desktop, server, or VPS). Run `s2code-nightly up` there and connect over LAN, Tailscale, desktop-managed SSH, or a configured S2 Connect relay. See [Remote access](./remote-access.md).

## How do I use S2Code on my phone?

On iPhone, join the fork's [public TestFlight beta](https://testflight.apple.com/join/vhmETHSn). On Android, use the web client. Your host computer runs the agents and must stay on. See [Mobile app](./install.md#mobile-app) and [Remote access](./remote-access.md).

## Why does S2 Connect keep disconnecting?

Open **Settings → Environments**, select the machine, and choose **Details**—the first failed check identifies the cause. See [S2 Connect troubleshooting](./t3-connect-troubleshooting.md). Tailscale also works great as a direct fallback.

## Will I get banned for using my subscription?

No. S2Code stays within the TOS of Claude Code, Codex, Google Antigravity, Grok Build, Cursor, and official ACP bindings.

## Can I add a bunch of accounts for one provider?

S2Code intentionally does not include an automatic multi-account switcher to avoid risking provider TOS bans. Adding a separate work/personal account is supported ([Codex](./providers-codex.md#use-multiple-accounts), [Claude](./providers-claude.md#multiple-accounts-and-presets)). For larger pools managed externally (e.g. via [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)), S2Code can display pooled limits under Usage ([Connect a hub](./usage.md#connect-a-cliproxyapi-hub)).

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in **Settings → Providers** with its own environment variables and endpoint (your subscription setup stays untouched). See [OpenRouter for Claude](./providers-claude.md#openrouter-and-local-routers) and [Providers](./install.md#providers).

## Does S2Code support local models?

No. S2Code focuses on frontier coding agents.

## Does my code go to S2Code servers?

No. Code and prompts go directly from your machine to your chosen provider. With S2 Connect, the configured relay sets up a Cloudflare tunnel without proxying your HTTP or WebSocket sessions.

S2Code sends no background usage data, fingerprints, mobile crash reports, or relay traces. Agent feedback and OpenTelemetry export stay off unless you enable them. See [Telemetry and data flows](./telemetry.md).

## Worktrees are eating my disk. How do I clean them up?

Enable automatic cleanup or run **Delete now** in **Settings → Worktrees → Cleanup**. See [Storage cleanup](./project-settings.md#storage-cleanup).

## Is there voice input?

Yes—on-device speech on iOS, Android, and macOS 26+ desktop, or via a paired environment on web/desktop/mobile. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three (desktop app and CLI). Note: there is no standalone `s2code` binary for Intel Macs (use the desktop app there), and Windows users can also run agents inside WSL. See [Install](./install.md).

## Why is my provider not showing up?

Usually the provider CLI is not installed, not signed in, or not on the `PATH` of the **server machine** (especially with version managers). Authenticate on the server machine first (e.g. `codex login` or `claude auth login`) and set **Binary path** in **Settings → Providers** if needed.
