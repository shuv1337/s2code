# Contributing to S2Code

Contributions are welcome: bug fixes, features, documentation updates, provider improvements, and fork enhancements.

If you plan a large change or architectural shift, open an issue in [GitHub Issues](https://github.com/shuv1337/s2code/issues) first so we can align on the approach before you invest time.

## Getting started

Follow the [development runbook](docs/operations/00_development.md#first-checkout) to install Vite+ (`vp`), install dependencies with `vp i`, and run `vp run dev`.

Before you push, run the fast changed-files check:

```bash
vp run check:changed
```

Avoid running repo-wide `vp check` or `vp run -r test` locally unless you need to; CI runs the full suite.

## Pull request guidelines

<a id="one-problem"></a>

### One problem per PR

Solve one problem or implement one cohesive feature per pull request. Include every change it needs across contracts, server, clients, tests, and docs. Put unrelated cleanups or separate fixes in their own PRs.

<a id="verification"></a>

### Show that it works

Describe what you changed, how you tested it, and what you observed. "Tests pass" alone is not enough for user-visible behavior.

For UI changes, include clear before and after screenshots. For motion, timing, or interaction changes, add a short recording. Upload media directly to the PR description and never commit PR-only assets.

### Commit titles and PR descriptions

Use plain-language conventional commit titles, such as:

- `fix(web): prevent duplicate thread subscriptions on reconnect`
- `feat(server): add custom binary path probe timeout`
- `docs(readme): document fork install commands`

PRs developed with automated tools are welcome; note the setup used at the end of the PR body as described in [AGENTS.md](AGENTS.md#pull-requests).

### Zero telemetry

S2Code sends no background analytics, fingerprints, relay traces, or mobile crash reports. Do not add any network call that sends user or diagnostic data off the machine unless the user explicitly enables it and the behavior is documented in [docs/user/telemetry.md](docs/user/telemetry.md). Run `vp test run scripts/zero-telemetry.test.ts` whenever you touch telemetry, observability, or relay code.

### Fork boundary

Open pull requests against `shuv1337/s2code`. Do not open pull requests against upstream `pingdotgg/t3code` on this fork's behalf.

## Reporting security issues

Report security vulnerabilities privately rather than posting exploit details in a public issue. See [SECURITY.md](SECURITY.md) for private advisory reporting (and the fallback contact flow if advisories are not yet enabled) plus our threat model.
