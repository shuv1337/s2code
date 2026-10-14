// @effect-diagnostics-next-line nodeBuiltinImport:off -- Receipt identity is a pure synchronous digest; Effect Crypto requires a runtime service.
import * as NodeCrypto from "node:crypto";
import { WatchCommandErrorCode, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class DispatchAdmissionRejectedError extends Schema.TaggedError<DispatchAdmissionRejectedError>()(
  "DispatchAdmissionRejectedError",
  { code: WatchCommandErrorCode },
) {
  override get message(): string {
    return `admission:${this.code}`;
  }
}

const isWatchCommandErrorCode = Schema.is(WatchCommandErrorCode);
/** Stable receipt representation, also used for previously rejected dispatches. */
export const parseAdmissionRejection = (error: string): Option.Option<WatchCommandErrorCode> => {
  const code = error.startsWith("admission:") ? error.slice("admission:".length) : undefined;
  return isWatchCommandErrorCode(code) ? Option.some(code) : Option.none();
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  }
  return value;
}

/** Fingerprint admitted commands before replay; principal is checked separately. */
export function dispatchPayloadFingerprint(command: OrchestrationV2ServerCommand): string | null {
  // Ordinary launch/intake retries regenerate workspace and attachment details.
  // Keep their established command-id replay semantics; authenticated admission
  // commands require exact payload identity and must never use that legacy path.
  if (
    command.type !== "message.dispatch" ||
    (command.admission === undefined && command.principal === undefined)
  )
    return null;
  const { principal: _principal, admission, ...payload } = command;
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          ...payload,
          ...(admission === undefined
            ? {}
            : {
                admission: { ...admission, notAfter: DateTime.formatIso(admission.notAfter) },
              }),
        }),
      ),
    )
    .digest("hex");
}
