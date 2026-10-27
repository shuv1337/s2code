# Install S2Code

S2Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch S2Code and configure providers afterwards.

## Command line

The commands below require a release built for the S2Code name. Earlier releases
use `shuv2code`; existing installations can keep updating in place. For a fresh
installation, choose a release with `s2code` CLI archives. Do not substitute
upstream's `t3` package or installers.

```bash
curl -fsSL https://raw.githubusercontent.com/shuv1337/s2code/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/shuv1337/s2code/main/scripts/install.ps1 | iex
```

The fork publishes nightly builds only, so the installer follows the nightly train
and installs the `s2code-nightly` command to `~/.local/bin`. If your shell
reports `command not found` afterwards, that directory is not on your `PATH` yet;
the installer prints the line to add. Set `S2CODE_VERSION` to pin an exact version.

### Keep upstream and fork installations separate

A fresh default install follows the nightly train and uses
`~/.s2code-v2-nightly`. Existing verified `~/.shuv2code-v2-nightly` installations
continue using their current home. The same rule applies to stable and preview.
If both old and new homes contain state, select one explicitly; they are never merged.
Set `S2CODE_HOME` for a different
home, `S2CODE_PORT` for a server port, and `S2CODE_RELEASE_BASE_URL` for a
release-download mirror. Public settings use the `S2CODE_` prefix. Legacy
`SHUV2CODE_*` settings remain accepted; a nonempty `S2CODE_*` value wins.
Existing `shuv2code*` command aliases remain supported. Inherited
upstream `T3CODE_` settings are ignored, with a notice for `T3CODE_HOME`, even
when a service-launcher context is inherited. Older maintainer-local fork
services must be stopped and reinstalled with explicit `S2CODE_HOME` before
updating; their old `T3CODE_HOME` setting is not adopted.
If the binary was already updated, an old unit or unmarked active runtime pauses
without starting a server. Its log says **Service paused until reinstall** rather
than repeatedly restarting. Reinstall with `s2code-nightly service install`
using the same explicit, verified fork `S2CODE_HOME`; upstream homes are still refused.

An empty custom home is claimed automatically. Historical installations in the
exact legacy stable default home remain usable; other nonempty default homes must be
already fork-marked. Runtime caches without product metadata
are downloaded again, never reused based on their directory name.
An existing custom home without product metadata is refused: verify offline
that it belongs exclusively to this fork before adding `.product-identity`
containing `s2code`. Existing markers containing `shuv2code` remain valid and are
not rewritten. Do not use this to adopt upstream state.
Runtime installs write `.install-product` containing `s2code` and a separate
version-only `.install-complete`, compatible with retained service launchers.
Foreign-marked caches and paths outside the owned home are never replaced.

Upstream import is not supported. Never point `S2CODE_HOME` or `--base-dir` at
an upstream home, live database, or shared runtime cache; use a separate home.
Setting `S2CODE_IMPORT_UPSTREAM` reports this limitation rather than importing.

| Task                                             | Command                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Start the server and open the web app            | `s2code-nightly`                                                                    |
| Start the server without a browser               | `s2code-nightly serve`                                                              |
| Keep it running in the background (macOS, Linux) | `s2code-nightly service install` ([details](./background-service.md))               |
| Move to the newest release                       | `s2code-nightly update`                                                             |
| Reclaim database space                           | `s2code-nightly doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                                  | `s2code-nightly uninstall`                                                          |

These examples use `s2code-nightly`, the command a default install creates.
Stable (`s2code`) and preview (`s2code-preview`) are reached only by setting
`S2CODE_CHANNEL`, and neither train is published today. A published npm install uses
the fork package `s2code`; uninstall only that proven package/prefix, never `t3`.

Run `s2code-nightly help` or `s2code-nightly --help` for the full reference. To start in
a new working directory, use an explicit path such as `s2code-nightly ./my-project`. A bare
directory name is accepted only if it already exists.

If the command or its `start` subcommand reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

Do not use `npx t3` to try this fork: it downloads upstream. Once the fork npm
package is published, `npx @s2code/cli` runs the newest nightly, because nightly
is the only train this fork publishes.

### Intel Macs

There is no standalone fork executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](https://github.com/shuv1337/s2code#install-vp)):

```bash
git clone https://github.com/shuv1337/s2code s2code
cd s2code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

Release self-update does not apply to a server run from source;
update it with `git pull` and a rebuild.

## Desktop app

### Fork release channels

Only nightly is published. Fresh installations use `~/.s2code-v2-nightly`;
upgraded installations keep their existing `~/.shuv2code-v2-nightly` data.
The desktop app keeps its existing Electron profile name so saved connections
and credentials remain available. No directory migration is needed.

macOS and Windows desktop builds update automatically only when signed; Linux
updates use checksums. A release titled UNSIGNED identifies which platforms need
to be updated by downloading the new build.

Preview (including PR builds) is a third, independent installation using
`~/.s2code-v2-preview`. It does not update automatically; replace it manually.
Channel links use `s2code://`, `s2code-nightly://`, or
`s2code-preview://`, respectively. Development owns `s2code-dev://`. The corresponding `shuv2code*://`
schemes remain registered so existing automation and auth callbacks continue to work.
Stream Deck and other automation must use the intended channel's scheme, for
example `s2code-nightly://threads/<environment-id>/<thread-id>` for nightly.

Older local nightly builds used the shared stable home. A new nightly launch
leaves that data untouched and logs its location; open stable to access it.
Nothing is moved or copied automatically. To transfer data manually, stop both
apps and their services first, back up the source, then copy into the separate
nightly home while everything is offline. Do not share or link a live database.

When a verified fork release is published, download the intended channel from
[S2Code releases](https://github.com/shuv1337/s2code/releases). If it is not
available yet, build the fork from source rather than installing upstream as a
substitute. Artifacts keep the `S2Code-<version>-<arch>` file naming, but the
installed package identities, commands, icons and desktop entries are fork-owned
and channel-specific. Upstream Winget, Homebrew, Scoop and AUR packages do not
install these fork identities, and no fork Winget, Scoop or Homebrew registration
is configured here.

| Platform           | Install                                      |
| ------------------ | -------------------------------------------- |
| Windows, macOS     | Fork GitHub release installer                |
| Debian, Ubuntu     | `sudo apt install ./S2Code-VERSION-ARCH.deb` |
| Arch Linux stable  | `s2code-bin` recipe                          |
| Arch Linux nightly | `s2code-nightly-bin` recipe                  |

Stable and nightly Linux packages can be installed side by side with each other
and upstream. Their commands are `s2code` and `s2code-nightly`. Preview has
its own Debian identity, but no AUR package. The fork AUR recipes are implemented;
once published, install them with `yay -S s2code-bin` or
`yay -S s2code-nightly-bin`. Until then, use GitHub Releases or build the recipes
against an actual fork release.

`brew install --cask t3-code`, `scoop install extras/t3code`, and
`winget install T3Tools.T3Code` install **upstream T3 Code**, not this fork. No fork
Homebrew, Scoop or Winget package is available.

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### The bundled command

The desktop app includes a fork command-line tool. To run it from any
terminal, open **Settings → About** and choose **Install** next to
the bundled command. On macOS and Linux it adds the installed channel's command to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes only that fork command off again. Upstream
and other fork channels remain separate.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. S2Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
s2code-nightly app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `s2code-nightly app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Fork mobile apps are not available yet: there are no fork App Store, Google Play,
TestFlight or beta-group destinations. Upstream store/beta apps are not a substitute
for the fork. Use the connected web client until a fork mobile distribution exists.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from S2Code's provider settings.                                                                                          |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If S2Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

S2Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when S2Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with S2Code. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, S2Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md),
[Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating S2Code](./updating.md): update the app and connected servers.
