# FAQ

## Is S2Code a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, runs them, and hands the results back. Claude Code combines an interface with the Anthropic Agent SDK harness underneath; Codex pairs its interface with the Codex App Server. S2Code drives those harnesses from one control surface. It is not a harness and does not work without one.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, fx, or any [ACP](./providers-acp.md) agent. [Provider setup](./install.md#providers)

## Why use S2Code instead of Claude Code or the Codex app?

S2Code gives you one consistent workspace across every agent you run:

- Bring your own subscriptions across Claude, Codex, Cursor, OpenCode, and other installed CLIs.
- Built-in remote control: run `s2code-nightly up` on any machine and drive it from anywhere.
- Mobile and Apple Watch companion support over LAN, Tailscale, or S2 Connect.
- Zero background telemetry, MIT open source, and open contributions.

See [Install](./install.md) to get started.

## Can I use S2Code with my Claude Code subscription?

Yes.

## How much does S2Code cost?

Nothing. S2Code is free and open source under the MIT license. You bring your own provider subscriptions or API keys and pay your providers directly. Local networking, Tailscale, and desktop-managed SSH require no hosted account, and you can self-host or configure your own S2 Connect relay if needed. [Install](./install.md)

## Why is my Claude 5-hour limit draining so fast?

It should not anymore. S2Code drives Claude through Anthropic's Agent SDK, and older Agent SDK releases charged Anthropic's 5-hour meter higher than direct Claude Code usage (weekly limits were unaffected). Current S2Code releases drain the 5-hour limit at the same rate as Claude Code. If you still see faster drain, [update S2Code](./updating.md) on the machine that runs your agents.

## How do I use S2Code remotely?

Your agents run wherever the S2Code server runs: your desktop, a home server, or a VPS. Run `s2code-nightly up` on that machine and connect from another computer or phone over direct LAN pairing, Tailscale HTTPS, desktop-managed SSH, or an operator-configured S2 Connect relay. [Remote access](./remote-access.md)

## How do I use S2Code on my phone?

Join the iOS public [TestFlight beta](https://testflight.apple.com/join/vhmETHSn) (which also includes the [Apple Watch](./apple-watch.md) companion), then connect it to your computer with a pairing link, Tailscale, or S2 Connect. There is no fork App Store or Google Play listing; on Android, connect with the web client. Your computer still runs the agents and must stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Why does S2 Connect keep disconnecting?

S2 Connect is an optional tunnel alternative to Tailscale for remote connections. If it keeps dropping, open **Settings > Environments**, find the machine, and select **Details**. The first part marked as failed shows the cause. Adding a direct LAN or Tailscale route gives you automatic fallback when a tunnel drops. [S2 Connect troubleshooting](./t3-connect-troubleshooting.md)

## Will I get banned for using my subscription?

S2Code drives each provider through its official CLI, SDK, or ACP binding using your own local authentication. It does not scrape private endpoints or spoof client traffic. Always follow each provider's terms of service when configuring accounts and automation.

## Can I add multiple accounts for one provider?

Yes, for separate workspaces such as personal and work accounts. Add a second provider instance in **Settings > Providers** with its own config directory or credentials: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations).

S2Code does not include an automatic account switcher. If you already manage pooled accounts externally through a self-hosted proxy such as [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), S2Code can display its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does S2Code support local models?

S2Code does not ship a built-in local-model provider, because it relies on agent harnesses rather than raw completion endpoints. You can connect any compatible [ACP agent](./providers-acp.md) or point a custom provider instance (such as OpenCode or a custom API endpoint) at a local model server in **Settings > Providers**.

## Does my code go to S2Code servers?

No. Your code and prompts go directly from your machine to your configured provider (Anthropic, OpenAI, and so on), not to S2Code servers. With S2 Connect, traffic rides a Cloudflare tunnel (`cloudflared` on your machine); the relay sets up the link and does not proxy your HTTP or WebSocket sessions. S2Code sends no background usage data, fingerprints, crash reports, or relay traces. Optional Agent feedback and OpenTelemetry export stay off unless you explicitly enable them. [Telemetry and data flows](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast on active repositories. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default, with the option to use a paired environment. On macOS 26 or later, desktop users can choose Apple Speech directly under **On this Mac** or choose an environment. Web and other desktop users can enable dictation by choosing an environment. The transcript goes into your draft for review. See [Voice input](./voice-input.md). For a two-way voice session, use Call after adding an OpenAI key in Settings → Voice calls. [Voice calls and dictation](./composer.md#voice-calls-and-dictation)

## Does it work on Windows, Mac, and Linux?

Yes, all three—desktop app and CLI. Two catches: Intel Macs and Windows on Arm are no longer built. Existing Intel installs stop getting updates but keep offering one that fails to download ([details](./install.md#intel-macs)), and existing Windows on Arm installs are updated to the x64 build, which runs emulated and may break WSL or fail to start on Windows 10 on Arm ([details](./install.md#windows-on-arm)). On those machines [run from source](./install.md#intel-macs) or connect to a server elsewhere. Windows users can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server (not your phone—the computer). Log in on that machine first, such as `codex login` or `claude auth login`. Still missing? Set **Binary path** in provider settings. Version managers commonly cause this when non-interactive shells use a different `PATH`. [Provider setup](./install.md#providers)
