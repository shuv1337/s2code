# FAQ

## Is S2Code a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is kind of a harness. It is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. S2Code uses those harnesses. It is not a harness, and it does not work without one.

Chef = LLM. Kitchen = harness. S2Code = the restaurant that lets you bring whatever kitchen you want. Our MCP is a cookbook we hand the kitchen, but the chef won't open it unless you tell them to :) See [What is a harness?](https://t3.gg/blog/post/what-is-a-harness) for the long version.

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, or fx. [Provider setup](./install.md#providers)

## Why use S2Code instead of Claude Code or the Codex app?

We were inspired by the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass, but none met our bar. What you get:

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Best in class remote. Run `s2code-nightly up` on any box and drive it from anywhere.
- Best in class mobile app.
- Truly 100% open source. If we go the wrong direction, fork it.

Every harness feels nearly identical in here, so you can stop worrying about harnesses and focus on building :) [Install](./install.md)

## Can I use S2Code with my Claude Code subscription?

Yes.

## How much does S2Code cost?

Nothing. S2Code is free and open source (MIT). You bring your own sub and still pay your provider like you already do. Upstream T3 Connect is free too, for now. Every account can connect up to 3 machines running T3 Code. Phones and browsers that connect to them do not count. Need more? Link a paid T3 Chat account. [More machines](#can-i-connect-more-than-3-machines-with-t3-connect) If you hit limits or have issues, you can always fork it, self host, or use Tailscale. [Install](./install.md)

## Can I connect more than 3 machines with T3 Connect?

Yes. Link your T3 Chat account and T3 Connect raises your limit: up to 10 machines with T3 Chat Pro, or 100 with Premier. Open your account menu in upstream T3 Code, go to **T3 Chat**, and select **Link T3 Chat**. Sign in to T3 Chat and approve. The free T3 Chat plan keeps the normal limit of 3. [More machines with T3 Chat](./remote-access.md#more-machines-with-t3-chat)

## Why is my Claude 5-hour limit draining so fast?

It shouldn't anymore. S2Code drives Claude through Anthropic's Agent SDK, and Anthropic's 5h meter used to charge Agent SDK usage about 1.7x more than using Claude Code directly. Weekly limits were never affected. Since upstream v0.1.7, Claude in the app drains your 5h limit at the same rate as Claude Code. Still seeing it? [Update S2Code](./updating.md) on the machine that runs your agents. [Upstream post](https://x.com/theo/status/2114166439813017873) · [Tracking issue](https://github.com/pingdotgg/t3code/issues/24649)

## How do I use S2Code remotely?

Your agents run wherever S2Code runs: your desktop, a server, or a VPS. Run `s2code-nightly up` on that machine and connect using LAN pairing or Tailscale. T3 Connect and the hosted web client at [app.t3.codes](https://app.t3.codes) are upstream services. [Remote access](./remote-access.md)

## How do I use S2Code on my phone?

Get the [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code) app, then connect it to your computer with T3 Connect or a pairing link. The phone is a remote. Your computer does the work and needs to stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Why does T3 Connect keep disconnecting?

T3 Connect is our built-in alternative to Tailscale for remote connections. If it keeps dropping, open **Settings > Environments**, find the machine, and select **Details**. The first part marked as failed is the cause. I will not be disappointed if you set up Tailscale as a fallback (I do this personally). [T3 Connect troubleshooting](./t3-connect-troubleshooting.md)

## Will I get banned for using my subscription?

Upstream T3 Code works with the labs and is within the TOS of Claude Code, Codex, and Google Antigravity. The upstream team worked directly with [SpaceXAI](https://x.com/SpaceXSI/status/2070195830192320600) on the Grok Build and Cursor integrations. Everything else uses official ACP bindings.

For a specific provider or account, check its current terms.

## Can I add a bunch of accounts for one provider?

S2Code does not auto-switch between accounts. That could risk TOS bans.

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside S2Code with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). The upstream team walks through one setup in [this video](https://www.youtube.com/watch?v=D8PikZ1KhUo) and [this guide](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af). After you set up a hub, S2Code can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does S2Code support local models?

No. S2Code is a serious developer tool. Locally runnable models are not capable of meaningful engineering work.

## Does my code go to T3 servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to us. With T3 Connect, traffic rides a Cloudflare tunnel (`cloudflared` on your machine). The relay sets up the link. It does not proxy your HTTP or WebSocket sessions. S2Code does send basic product usage events (provider, model, token totals, that kind of thing). No prompts, no file contents. That is the same on Tailscale, LAN, or T3 Connect. Set `T3CODE_TELEMETRY_ENABLED=false` if you want it off. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast. One user cleared 500 GB. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default; you can opt in to a paired environment instead. Web and desktop require you to choose an environment first. The transcript goes into your draft for review. See [Voice input](./voice-input.md). For a two-way voice session, use Call after adding an OpenAI key in Settings → Voice calls. [Voice calls and dictation](./composer.md#voice-calls-and-dictation)

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. Two catches: Intel Macs and Windows on Arm are no longer built. Existing Intel installs stop getting updates but keep offering one that fails to download ([details](./install.md#intel-macs)), and existing Windows on Arm installs are updated to the x64 build, which runs emulated and may break WSL or fail to start on Windows 10 on Arm ([details](./install.md#windows-on-arm)). On those machines [run from source](./install.md#intel-macs) or connect to a server elsewhere. Windows folks can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. (Not your phone. The computer.) Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers love to cause this one. [Provider setup](./install.md#providers)
