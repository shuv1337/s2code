# S2Code

A branded fork of [T3 Code](https://github.com/pingdotgg/t3code), retaining its provider and
client architecture with the devil-terminal identity and Apple Watch work.

## Run this fork

Use [fork builds](https://github.com/shuv1337/s2code/releases) or build from source with
`vp i` and `vp run dev`. [Fork packaging instructions](docs/operations/release.md#matrix-and-source)
cover desktop artifacts. Published fork CLI packages use `s2code` / `s2c`.

Fresh installations use `~/.s2code-v2` (with `-nightly` or `-preview` for those channels)
and a separate Electron profile. Existing verified `~/.shuv2code-v2*` homes and profiles
remain in place. If both names contain state, select the intended home explicitly with
`S2CODE_HOME`; no databases are merged. Legacy `SHUV2CODE_*` settings remain accepted,
with nonempty `S2CODE_*` values taking precedence. Installed fork commands ignore upstream `T3CODE_*` settings.
The desktop automatically attaches to an already-running fork server in that home when
their exact versions match. Quitting the desktop leaves that server running.

Local networking and Tailscale are the primary remote paths. Fork-hosted Connect and mobile
OTA need their own deployment configuration. Upstream app-store and package-manager links
below install T3 Code, not this fork.

## Product

S2Code is an "agent harness control surface". It enables control of the agents on your machine from web, mobile, and desktop clients.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, S2Code can control them.

## "Wait, what are you selling me?"

Nothing. S2Code exists to provide the best possible development experience with agents.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> S2Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://raw.githubusercontent.com/shuv1337/s2code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/shuv1337/s2code/main/scripts/install.ps1 | iex
```

The fork publishes nightly builds only, so this installs the nightly train. Then run `s2code-nightly` to start the server and open the local web app. `s2code-nightly service install` keeps it running in the background, `s2code-nightly update` moves to a newer release, and `s2code-nightly --help` has the full reference.

### Desktop app

Fork builds are distributed as nightly releases through [shuv1337/s2code GitHub Releases](https://github.com/shuv1337/s2code/releases).
They are separate installations and may coexist with upstream T3 Code.
Release files retain the `S2Code-<version>-<arch>` artifact naming convention.

#### Windows (`winget`)

Upstream T3 Code only; no fork Winget package is available:

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

Upstream T3 Code only; no fork Scoop package is available:

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

Upstream T3 Code only; no fork Homebrew cask is available. Install fork builds from GitHub Releases instead:

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the nightly `.deb` from the fork's [GitHub Releases](https://github.com/shuv1337/s2code/releases), then install that exact file:

```bash
sudo apt install ./S2Code-VERSION-ARCH.deb
```

#### Arch Linux (AUR)

Fork recipes are implemented in [`packaging/aur`](./packaging/aur). They are not a
claim that the package has already been published to AUR. The fork publishes only
nightly; after AUR publication:

```bash
yay -S s2code-nightly-bin
```

The package owns `s2code-nightly` and retains `shuv2code-nightly` as an alias.
It does not replace upstream T3 Code.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
