import {
  OrchestratorMcpFailure,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { Caller } from "./threadAccess.ts";

/**
 * Work started through a link (and all it starts) carries the session in `linkOrigin` and may
 * change only work from that link: not the user's threads, projects, settings, or other links.
 * Reads are not fenced. This routes T3's own tools; agents still run as this environment's user.
 */

/** The link a caller acts for: its own session, or the link that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined =>
  caller.caller?.linkOrigin ??
  (caller.scope.client?.linked === true
    ? { sessionId: caller.scope.client.sessionId, label: caller.scope.client.label }
    : undefined);

const outsideLink = (origin: OrchestrationV2LinkOrigin, message: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `This work was started from ${origin.label} through a linked environment, so ${message}`,
  });

/** A thread a linked caller may change: one its own link started. */
export const assertSameLink = (
  caller: Pick<Caller, "scope" | "caller">,
  target: Pick<OrchestrationV2ThreadShell, "id" | "linkOrigin">,
) => {
  const origin = callerLinkOrigin(caller);
  return origin === undefined || target.linkOrigin?.sessionId === origin.sessionId
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it may change only threads that link started.`));
};

/** Linked work never changes the environment itself: projects, settings, scheduled runs. */
export const assertNotLinked = (caller: Pick<Caller, "scope" | "caller">, what: string) => {
  const origin = callerLinkOrigin(caller);
  return origin === undefined
    ? Effect.void
    : Effect.fail(outsideLink(origin, `it cannot ${what}.`));
};
