# CLI reference (`s2code`)

The `s2code` command runs and manages S2Code servers, background services, remote access, threads, workflows, and diagnostics. Run `s2code --help` or `s2code <command> --help` for full flags.

See [Install S2Code](./install.md#command-line) for the fork installer or run `npx shuv2code` to try the latest nightly.

## Running and connecting

| Command                          | Description                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `s2code [path]` / `s2code start` | Start a foreground server and open the web app (optionally in a project directory).                                              |
| `s2code serve`                   | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`).                     |
| `s2code app [path]`              | Open a directory as a project/thread in the running desktop app.                                                                 |
| `s2code up`                      | Interactive setup for remote access (S2 Connect and/or LAN) plus background service (`--connect`, `--lan`, `--no-lan`, `--yes`). |
| `s2code connect`                 | Manage S2 Connect (`s2code connect`, `status`, `login`, `logout`, `link`, `unlink`).                                             |
| `s2code status`                  | Show how other devices can reach this host (`--json`).                                                                           |
| `s2code pair`                    | Generate a one-time pairing URL / QR code (`--tailscale`, `--scope <scope>`).                                                    |

## Background service and updates

| Command                               | Description                                                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s2code service`                      | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `s2code update [version]`             | Update `s2code` and the service on the installed channel (`--allow-downgrade`, `--yes`).                                                            |
| `s2code install` / `s2code uninstall` | Install or remove the `s2code` launcher and background service (keeps the fork's `userdata`).                                                       |

## Threads, projects, and workflows

| Command           | Description                                                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s2code thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Host scripts](./outside-agents.md#host-scripts-s2code-thread). |
| `s2code project`  | Manage projects on the host (e.g. `s2code project add <path> --track <folder>`).                                                                                                                                  |
| `s2code workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                            |

## Environments, auth, themes, and policy

| Command              | Description                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `s2code environment` | Link or manage peer environments (`s2code environment link <addr> --pairing-code <code> --access <mode>`, `--from <file>`).                            |
| `s2code auth`        | Manage pairing codes, sessions, and S2 Connect device approvals (`pairing create`, `session list/revoke/issue`, `connect-device list/approve/revoke`). |
| `s2code theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                                    |
| `s2code policy`      | Validate, inspect, and generate MDM/GPO templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`).              |

## Diagnostics and maintenance

| Command                | Description                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `s2code doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                       |
| `s2code browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser.   |
| `s2code trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                             |
| `s2code triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the T3 triage playbook.                    |
| `s2code feedback`      | Send or inspect agent feedback reports (`list [--json]`, `--kind`, `--subject`, `--expected`, `--actual`). |
