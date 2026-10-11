import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const WATCH_CLIENT_SUBJECT = "watch-client";
export const watchClientScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const;

/** Absent lists are unrestricted; present empty lists permit no targets. */
export const WatchRestriction = Schema.Struct({
  threadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
});
export type WatchRestriction = typeof WatchRestriction.Type;

// The entire opaque credential is stored by the existing one-time grant store.
// Matching it atomically in SQLite authenticates these grant-time restrictions.
export const WatchPairingCredential = Schema.Struct({
  nonce: Schema.String,
  restriction: WatchRestriction,
});
