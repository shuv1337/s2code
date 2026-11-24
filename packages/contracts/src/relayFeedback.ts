import * as Schema from "effect/Schema";

import { AgentFeedbackKind, AgentFeedbackTrace } from "./agentFeedback.ts";
import { ClientOs } from "./baseSchemas.ts";

export const RELAY_AGENT_FEEDBACK_MAX_TRACE_ENTRIES = 80;
const RELAY_AGENT_FEEDBACK_SUBJECT_PATTERN = /^[A-Za-z0-9_ .:/-]+$/u;

export const RelayAgentFeedbackSource = Schema.Literals(["mcp", "cli"]);
export type RelayAgentFeedbackSource = typeof RelayAgentFeedbackSource.Type;

export const RelayAgentFeedbackRequest = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  createdAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  kind: AgentFeedbackKind,
  subject: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
    Schema.isPattern(RELAY_AGENT_FEEDBACK_SUBJECT_PATTERN),
  ),
  expected: Schema.String.check(Schema.isMaxLength(2_000)),
  actual: Schema.String.check(Schema.isMaxLength(2_000)),
  workaround: Schema.String.check(Schema.isMaxLength(2_000)),
  userRequested: Schema.Boolean,
  source: RelayAgentFeedbackSource,
  trace: Schema.NullOr(AgentFeedbackTrace),
  provider: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
  serverVersion: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  telemetryChannel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  serverOs: Schema.optionalKey(ClientOs),
  serverArch: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  serverMode: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
});
export type RelayAgentFeedbackRequest = typeof RelayAgentFeedbackRequest.Type;

export const RelayAgentFeedbackResponse = Schema.Struct({
  ok: Schema.Literal(true),
  duplicate: Schema.Boolean,
});
export type RelayAgentFeedbackResponse = typeof RelayAgentFeedbackResponse.Type;
