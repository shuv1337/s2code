# Maintenance, power, and diagnostics

Control how aggressively S2Code runs background checks, keep your computer awake while agents work, inspect server health, and analyze local trace files.

## Background activity and power

Configure under **Settings → Maintenance** (per environment):

- **Background activity**: Choose **Balanced**, **Performance**, or **Battery saver**—or expand **Advanced** to customize pausing on host lock / low-power / battery, **Git fetch interval**, and provider health check intervals.
- **Keep awake while agents work**: Prevents the host OS from sleeping while an agent turn is running.
- **Continue threads after restarts**: Automatically resumes supported active threads after an update, crash, or reboot ([details](./updating.md#continue-threads-after-restarts)).
- **Provider update checks**: Enables checking for newer provider CLIs and updated model catalogs.
- **Artifacts and logs / Delete now**: Manage disk cleanup ([Storage cleanup](./project-settings.md#storage-cleanup)) and database compaction ([Reclaim database space](./background-service.md#reclaim-database-space)).

## Diagnostics view

Open **Settings → Maintenance → Diagnostics** (select an environment) to inspect:

- Live server logs and recent failures
- Trace spans and CPU/memory resource history
- Running child processes (with controls to signal or stop them)
- **OpenTelemetry export** (OTLP HTTP endpoints; see [Export diagnostics](./telemetry.md#export-diagnostics-to-your-own-receiver))

The mobile app does not send crash reports. You can manually copy startup diagnostics that are stored on the device. See [Local-only diagnostics](./telemetry.md#local-only-diagnostics).

## Inspect local trace files (`s2code-nightly trace`)

Summarize latency, rates, interrupts, and failures from the server's rotated trace files directly from the host terminal:

```sh
s2code-nightly trace summary                    # Top 25 busiest spans
s2code-nightly trace summary --since 30m        # Spans ended in the last 30 minutes
s2code-nightly trace summary --since 2h --limit 50
```

Pass `--base-dir <path>` (or set `S2CODE_HOME`) for a non-default data directory.
