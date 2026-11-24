import * as Schema from "effect/Schema";

// S2Code does not collect install or owner identifiers. Only the contract types remain for AnalyticsService.
export const TelemetryOwnerSource = Schema.Literals(["connect", "openai", "claude", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  readonly ownerId: string;
}
