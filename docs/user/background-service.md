# Running S2Code in the background

On Linux and macOS, S2Code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the fork CLI first ([Install S2Code](./install.md#command-line)), then
run these commands on the machine that will host S2Code:

| Task                            | Command                    |
| ------------------------------- | -------------------------- |
| Install and start               | `s2code service install`   |
| Inspect status and log location | `s2code service status`    |
| Move to a newer release         | `s2code update`            |
| Restart                         | `s2code service restart`   |
| Stop and remove from startup    | `s2code service uninstall` |

Examples use stable. Existing installations may retain the legacy service name;
use the service and log paths printed by `s2code service status`. Nightly uses `s2code-nightly`; preview uses
`s2code-preview`. For npm/runner/source installs, use the exact invocation
printed by the server, not an upstream `t3` command.

The desktop app uses a running service instead of starting its own server, and
quitting the app leaves the service running. When the app has updated past the
service, it moves the service to its own version on launch, interrupting work
running in it. The app's network access setting does not apply to the service;
see [Local network access](#local-network-access).

Uninstalling the service leaves your projects, threads, and settings intact.
Running `s2code service install` again repairs a service that `s2code service status`
reports as broken.

`s2code update` downloads the newest fork release on your channel and switches its launcher
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `s2code service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating S2Code](./updating.md).

Pass an exact version on the installed channel to pin one, or
`--allow-downgrade` to move backwards within that channel. Stable, nightly and
preview are separate installations: CLI and remote server updates cannot switch
trains. Install the other channel separately with its own home and service.
Preview builds do not update automatically.

`s2code uninstall` removes only that channel's background service, launcher, and
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under the fork channel's home (stable: `~/.s2code-v2/userdata`) are kept,
along with `service.env` in that home. Pass `--yes` from a script.

## Local network access

The service listens on your local network and Tailscale addresses, so the
desktop and mobile apps on the same network connect directly. The service does
not answer on public addresses, and every device still needs to pair. To keep
the service reachable from this machine only, set `SHUV2CODE_HOST=127.0.0.1` in
`service.env` (below). Any `SHUV2CODE_HOST` value replaces this default.

## Configure the service environment

Put custom environment variables in `service.env` in the service channel's home
directory (stable: `~/.s2code-v2/service.env`). This file survives service
installation and updates. For example:

```dotenv
SHUV2CODE_PORT=3773
SHUV2CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, the home
directory variables, `T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT`
(including case variants).

Run `s2code service restart` after changing the file. Changes apply when the
service starts again; switching the server version alone keeps the current
values. For a service installed before env-file support, run
`s2code service install` once with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the stable home, `chmod 600 ~/.s2code-v2/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so S2Code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

T3 Connect can offer service installation during setup, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Linux agent memory budget

With a systemd user manager, s2code agents and terminals share one memory
budget across all of your fork environments, development servers, and release
channels. Channels remain separate installations, but a runaway agent in one
can cause an agent in another to be killed.

This is not a host-wide memory reservation. Upstream T3 Code has an independent
budget: on a 16 GiB machine, each product can allow up to 12 GiB of agents, so
running both near their limits can exhaust the host before either reaches its
own cap. Limit simultaneous work across the two products, or ask your host
administrator to configure an aggregate memory limit. The fork does not change
upstream's limits or stop its agents.

Sessions already running when you upgrade from a fork build that used upstream's
slice stay there until they exit. Stop those sessions yourself and start new ones
to use the separate fork budget; the upgrade does not move or clean up upstream-
named scopes. Old runtime limits remain until the systemd user manager restarts.

## Keep the server responsive when agents use all memory

On Linux, agents already run with lower priority than the server. When they
fill the machine's memory, though, the kernel may still slow down or stop the
server, because only an administrator can reserve memory for it. Run, as your
normal user:

```sh
s2code service protect
```

It shows the system settings it will change, asks before applying them, and
then asks for your sudo password. If the machine runs Tailscale or SSH, it
also offers to protect them, so you can still reach the machine. Memory
protection takes effect at once. The server's protection from the kernel's
out-of-memory killer takes effect after `s2code service restart`. `s2code service status` reports whether
the protection is in place, and `s2code service protect --undo` removes it.

## Troubleshooting

Start with `s2code service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running S2Code as root creates a separate installation and Connect
identity. Without administrator access, run `s2code serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and the fork unit printed by service status (stable: `s2code-v2.service`), then use its repair command.           |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run the printed fork service restart command.        |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the runtime executable listed in
`ProgramArguments` in
the channel's launchd plist (stable: `~/Library/LaunchAgents/dev.shuv.s2code.v2.service.plist`).

For failures after signing in to T3 Connect, see
[connection troubleshooting](./t3-connect-troubleshooting.md).

## Reclaim database space

S2Code removes superseded internal history on its own while it runs; your
conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Maintenance (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

Run `s2code doctor` on the machine that hosts the environment. It reports the
database size and the space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `s2code doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings.
