import * as Effect from "effect/Effect";
import { AuthOrchestrationReadScope, type AuthEnvironmentScope } from "@t3tools/contracts";
import { requireWatchSession } from "../auth/WatchHttp.ts";
import { requireEnvironmentScope } from "../auth/http.ts";

/** The transport owns authentication; domain methods receive only session identity and scope. */
export const currentWatchPrincipal = Effect.fn("watch.currentPrincipal")(function* (
  scope: AuthEnvironmentScope = AuthOrchestrationReadScope,
) {
  const session = yield* requireWatchSession;
  yield* requireEnvironmentScope(scope);
  return { sessionId: session.sessionId, restriction: session.restriction };
});
