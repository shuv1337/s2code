import {
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./http.ts";

/** Populated only while the Watch HTTP middleware runs the handler. */
const CurrentWatchSession = Context.Reference<EnvironmentAuth.WatchClientSession | undefined>(
  "t3/auth/CurrentWatchSession",
  {
    defaultValue: (): EnvironmentAuth.WatchClientSession | undefined => undefined,
  },
);

export const requireWatchSession = Effect.gen(function* () {
  const session = yield* CurrentWatchSession;
  return session ?? (yield* failEnvironmentAuthInvalid("missing_credential"));
});

/** Provide to the Watch group only, never to the whole HTTP API. */
export const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return (handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateWatchClient(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        return yield* handler.pipe(
          Effect.provideService(CurrentWatchSession, session),
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
        );
      });
  }),
);
