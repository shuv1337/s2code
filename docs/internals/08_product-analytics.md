# Product analytics (zero-telemetry architecture)

S2Code sends no background product analytics, account or install fingerprints, relay client traces,
or mobile crash reports.

## Invariants

- [`AnalyticsService`](../../apps/server/src/telemetry/AnalyticsService.ts) is a zero-requirement
  no-op (`Layer.Layer<AnalyticsService>`). Keeping its three-member service shape lets upstream
  `analytics.record(...)` call sites merge unchanged while guaranteeing at compile time that it
  cannot reach HTTP, the filesystem, or config.
- [`Identify.ts`](../../apps/server/src/telemetry/Identify.ts) exports only `TelemetryOwnerSource`
  and `TelemetryOwner`. The server never reads provider auth files or Connect secrets for analytics
  and never creates `anonymous-id`. Clients send no `clientOwner` or `clientDevice` query params.
- [`RelayTracing.layer`](../../packages/shared/src/relayTracing.ts) unconditionally returns
  `Layer.succeed(RelayClientTracer, Option.none())` and
  [`isRelayTracingEnabled`](../../packages/shared/src/otelEnvironment.ts) unconditionally returns
  `false`. User-configured OTLP export (`OtelEnvironment.load` / `resolveSignalEndpoint`) stays
  intact and off until configured.
- `expo-observe` is removed from `apps/mobile/package.json` and `app.config.ts`.
- Opt-in [`FeedbackService`](../../apps/server/src/feedback/FeedbackService.ts) and
  [`FeedbackRelayDelivery`](../../apps/server/src/feedback/FeedbackRelayDelivery.ts) remain
  decoupled from `AnalyticsService`, default to `off`, and honor `S2CODE_TELEMETRY_ENABLED=false`
  and managed policy `limits.telemetry: false`.

## Upstream merges and guard test

When merging upstream, always take the fork side in: `apps/server/src/telemetry/AnalyticsService.ts`,
`apps/server/src/telemetry/Identify.ts`, `packages/shared/src/relayTracing.ts`, the
`isRelayTracingEnabled` export in `packages/shared/src/otelEnvironment.ts`,
`packages/client-runtime/src/authorization/remote.ts` (owner params),
`apps/mobile/src/features/observability/observe.ts` (kept deleted), `apps/mobile/app.config.ts`
(`observe` / `observability`), and `infra/relay/src/worker.ts` (`MobileTelemetry.layerDisabled`).
Review any new upstream network client or SDK dependency manually, then run
`vp test run scripts/zero-telemetry.test.ts`.
