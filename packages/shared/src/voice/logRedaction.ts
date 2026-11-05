/**
 * Redaction for persisted voice diagnostics. Allowlisted ids can be stored;
 * everything else is a length, and secret-shaped text is dropped.
 */
import { redactText } from "./resultSummary.ts";

const ALLOWED_ARG_KEYS = new Set(["threadId", "environmentId", "projectId"]);
const SENSITIVE_KEY =
  /sdp|audio|authorization|api[-_]?key|token|secret|password|bearer|ephemeral|cookie/i;
const SDP_LINE = /^(?:v=0|a=(?:ice-pwd|ice-ufrag|fingerprint)\b)/i;

export const redactVoiceLogText = (value: string, maxChars: number): string => {
  const newline = value.includes("\r\n") ? "\r\n" : "\n";
  const lines = value.split(/\r?\n/);
  const body = lines.some((line) => line.trim().startsWith("v=0"))
    ? "[redacted]"
    : lines.map((line) => (SDP_LINE.test(line.trim()) ? "[redacted]" : line)).join(newline);
  const redacted = redactText(body)
    .replace(/Bearer \[redacted\]/giu, "[redacted]")
    .replace(/\bek[-_][a-z0-9_-]{8,}\b/giu, "[redacted]");
  return redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted;
};

const valueLength = (value: unknown): number => {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (value == null) return 0;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : text.length;
  } catch {
    return 0;
  }
};

/** Allowlisted ids verbatim (still redacted); every other key is its value length. */
export const summarizeVoiceArgs = (
  args: Readonly<Record<string, unknown>>,
): Record<string, string | number> => {
  const summary: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY.test(key)) continue;
    summary[key] =
      ALLOWED_ARG_KEYS.has(key) && typeof value === "string"
        ? redactVoiceLogText(value, 200)
        : valueLength(value);
  }
  return summary;
};

export const voiceErrorFacts = (
  error: unknown,
): { readonly providerType?: string; readonly message: string } => {
  if (typeof error !== "object" || error === null) {
    return { message: redactVoiceLogText(String(error), 200) };
  }
  const record = error as { _tag?: unknown; message?: unknown; reason?: unknown };
  const providerType = typeof record._tag === "string" ? record._tag : undefined;
  const raw =
    typeof record.message === "string"
      ? record.message
      : typeof record.reason === "string"
        ? record.reason
        : (providerType ?? "unknown");
  return {
    ...(providerType === undefined ? {} : { providerType }),
    message: redactVoiceLogText(raw, 200),
  };
};
