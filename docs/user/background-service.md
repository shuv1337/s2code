# Running T3 Code in the background

On Linux and macOS, T3 Code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the fork CLI first ([Install shuv2code](./install.md#command-line)), then
run these commands on the machine that will host T3 Code:

| Task                            | Command                       |
| ------------------------------- | ----------------------------- |
| Install and start               | `shuv2code service install`   |
| Inspect status and log location | `shuv2code service status`    |
| Move to a newer release         | `shuv2code update`            |
| Restart                         | `shuv2code service restart`   |
| Stop and remove from startup    | `shuv2code service uninstall` |

Examples use stable. Nightly uses `shuv2code-nightly`; preview uses
`shuv2code-preview`. For npm/runner/source installs, use the exact invocation
printed by the server, not an upstream `t3` command.

Uninstalling the service leaves your projects, threads, and settings intact.
Running `shuv2code service install` again repairs a service that `shuv2code service status`
reports as broken.

`shuv2code update` downloads the newest fork release on your channel and switches its launcher
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `shuv2code service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating T3 Code](./updating.md).

Pass an exact version on the installed channel to pin one, or
`--allow-downgrade` to move backwards within that channel. Stable, nightly and
preview are separate installations: CLI and remote server updates cannot switch
trains. Install the other channel separately with its own home and service.
Preview builds do not update automatically.

`shuv2code uninstall` removes only that channel's background service, launcher, and
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under the fork channel's home (stable: `~/.shuv2code-v2/userdata`) are kept. Pass `--yes` from a
script.

## Platform support

Linux needs systemd user services. Setup enables lingering so T3 Code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

T3 Connect can offer service installation during setup, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Troubleshooting

Start with `shuv2code service status` on the host. It prints the log path and, on Linux,
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
with sudo; running T3 Code as root creates a separate installation and Connect
identity. Without administrator access, run `shuv2code serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and the fork unit printed by service status (stable: `shuv2code-v2.service`), then use its repair command.        |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run the printed fork service restart command.        |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the runtime executable listed in
`ProgramArguments` in
the channel's launchd plist (stable: `~/Library/LaunchAgents/dev.shuv.shuv2code.v2.service.plist`).

For failures after signing in to T3 Connect, see
[connection troubleshooting](./remote-access.md#t3-connect-troubleshooting).
