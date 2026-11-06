import * as Schema from "effect/Schema";

export class VoiceError extends Schema.TaggedError<VoiceError>()("VoiceError", {
  reason: Schema.Literals([
    "not_configured",
    "provider",
    "session_closed",
    "forbidden",
    "invalid_call",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_configured":
        return "Add an OpenAI API key in Voice settings to start.";
      case "provider":
        return "OpenAI could not connect the voice session. Check your key and GPT-Live access, then retry.";
      case "session_closed":
        return "This voice session has ended. Start a new call.";
      case "forbidden":
        return "Your connection does not have permission for this voice action.";
      case "invalid_call":
        return "This action is unavailable in voice.";
    }
  }
}
export const VoiceStartInput = Schema.Struct({
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
  mode: Schema.Literals(["call", "dictation"]),
});
export type VoiceStartInput = typeof VoiceStartInput.Type;
export const VoiceStartResult = Schema.Struct({ sessionId: Schema.String, sdp: Schema.String });
export type VoiceStartResult = typeof VoiceStartResult.Type;
export const VoiceToolInput = Schema.Struct({
  sessionId: Schema.String,
  callId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type VoiceToolInput = typeof VoiceToolInput.Type;
export const VoiceToolResult = Schema.Struct({
  status: Schema.Literals(["completed", "confirmation_required"]),
  output: Schema.String,
});
export type VoiceToolResult = typeof VoiceToolResult.Type;

const nonNegative = (max: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: max }));
const shortText = Schema.String.check(Schema.isMaxLength(200));
const idText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const VoiceReportRole = Schema.Literals(["user", "assistant"]);
const duration = nonNegative(86_400_000);

export const VoiceReportEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["connect", "reconnect", "disconnect"]),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    latencyMs: duration,
  }),
  Schema.Struct({
    type: Schema.Literals(["turn.start"]),
    turnId: idText,
    role: VoiceReportRole,
  }),
  Schema.Struct({
    type: Schema.Literals(["turn.end"]),
    turnId: idText,
    role: VoiceReportRole,
    durationMs: duration,
    firstAudioMs: Schema.optionalKey(duration),
  }),
  Schema.Struct({
    type: Schema.Literals(["transcript"]),
    role: VoiceReportRole,
    text: Schema.String.check(Schema.isMaxLength(2000)),
  }),
  Schema.Struct({
    type: Schema.Literals(["error"]),
    where: shortText,
    reason: shortText,
    providerType: Schema.optionalKey(shortText),
    message: shortText,
  }),
]);
export type VoiceReportEvent = typeof VoiceReportEvent.Type;
export const VoiceReportInput = Schema.Struct({
  sessionId: idText,
  mode: Schema.Literals(["call", "dictation"]),
  events: Schema.Array(VoiceReportEvent).check(Schema.isMaxLength(100)),
});
export type VoiceReportInput = typeof VoiceReportInput.Type;

/** Client reports that happen before the provider assigns a session id. */
export const VOICE_PRE_SESSION_ID = "pre-session";
