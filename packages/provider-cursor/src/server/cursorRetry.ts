// @effect-diagnostics nodeBuiltinImport:off -- Bridges the SDK's internal retry callback to the owning run.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import * as Schema from "effect/Schema";

export const CURSOR_CHECKPOINT_UNCERTAIN_MESSAGE =
  "Cursor could not confirm that this answer was saved. Automatic replay was stopped; the next message will recover in a fresh Cursor session.";

const RetryDiagnostic = Schema.Struct({
  requestId: Schema.String,
  originalRequestId: Schema.String,
  attempt: Schema.Number,
  decision: Schema.Literals([
    "retry",
    "throw",
    "blocked_after_turn_ended",
    "completed_from_checkpoint",
  ]),
  turnEnded: Schema.Boolean,
  checkpoint: Schema.String,
  cause: Schema.Unknown,
});

export type CursorRetryDiagnostic = typeof RetryDiagnostic.Type;

const diagnosticScope = new NodeAsyncHooks.AsyncLocalStorage<
  (event: CursorRetryDiagnostic) => void
>();
const isRetryDiagnostic = Schema.is(RetryDiagnostic);

NodeDiagnosticsChannel.subscribe("s2code.cursor.retry", (event) => {
  const receive = diagnosticScope.getStore();
  if (receive !== undefined && isRetryDiagnostic(event)) receive(event);
});

export function withCursorRetryDiagnostics<A>(
  receive: (event: CursorRetryDiagnostic) => void,
  run: () => A,
): A {
  return diagnosticScope.run(receive, run);
}

export function cursorRetryCause(cause: unknown) {
  const details = (error: unknown) => {
    if (!(error instanceof Error)) return { name: typeof error };
    const code: unknown = Reflect.get(error, "code");
    return {
      name: error.name.slice(0, 100),
      message: error.message.slice(0, 2000),
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    };
  };
  return {
    ...details(cause),
    ...(cause instanceof Error && cause.cause !== undefined ? { cause: details(cause.cause) } : {}),
  };
}
