# Updating S2Code

S2Code clients and servers can run on different machines and must share a compatible orchestration protocol. When a server or provider is behind, the sidebar update button and **Settings → Environments** handle updates.

## Update everything at once

Click the **Update** button at the bottom of the sidebar (web or desktop) to update outdated providers, behind servers, and the desktop app in one step.

- Hover to preview what will update; click while running to view per-machine progress or retry failures.
- Confirmation dialogs show which machines are skipped (offline or manual-only) and how many active threads will pause/resume.
- Choose **Later** on the desktop restart countdown to restart when ready.

## Release channels

Stable, Nightly, and Preview are separate installations and cannot be switched in place. The fork publishes nightly builds at [shuv1337/s2code releases](https://github.com/shuv1337/s2code/releases). **Settings → About → Installed channel** names the desktop app's channel.

## Continue threads after restarts

**Settings → Maintenance → Continue threads after restarts** is enabled by default. After an update, crash, or reboot (once S2Code starts again), supported active threads automatically resume—and threads waiting on subagents or monitors are woken and notified that background work stopped.

- Threads waiting for your approval/answer/secret—or archived, snoozed, or settled—are not auto-resumed.
- After 3 consecutive crash recoveries of an unfinished turn, the thread waits for your next message.
- Updating from V1? Read [Threads from older S2Code versions](./thread-migration.md).

## Update a connected server manually

| Situation                           | Action                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Background service / desktop server | Click **Update server** in **Settings → Environments** (desktop hosts relaunch automatically).                                |
| Installed `s2code` CLI              | Run `s2code-nightly update <version>` on the host (then `s2code-nightly service restart` if you declined the restart prompt). |
| `npx` server                        | Stop the server and relaunch with `npx shuv2code@<version>` and your usual flags.                                             |
| Package manager (Nix, AUR)          | Update via your package manager.                                                                                              |

Each server checks npm/Homebrew/pnpm using its own local registry and proxy settings.

## Update providers

Open **Settings → Providers** and click **Update now** on individual providers or **Update all** across connected environments. Running chats keep using their current CLI until they end; new sessions and model catalogs refresh automatically. (Provider update checks in **Settings → Maintenance** must be enabled to fetch model catalog updates.)

## Mobile updates

- Update connected environments and providers from **Settings → Environments** on mobile.
- Update the fork's iPhone app via [TestFlight](https://testflight.apple.com/join/vhmETHSn).

## Troubleshooting

- **Version mismatch**: Update whichever side (app or server) the connection notice names.
- **Failed update**: Retry once; confirm you updated the host machine (not just the client) and that only one server owns the T3 home directory.
- **Desktop won't start**: Use the recovery window's **Update** button, install the linked last-working version, or **Copy details** for a bug report.
