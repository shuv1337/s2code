import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedAuth,
  WATCH_MAX_BODY_BYTES,
  EnvironmentHttpApi,
  WatchRequestError,
  WATCH_DEFAULT_THREAD_PAGE_SIZE,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { failEnvironmentInternal } from "../auth/http.ts";
import { currentWatchPrincipal } from "./principal.ts";
import * as WatchService from "./WatchService.ts";
import * as WatchAuthHttp from "../auth/WatchHttp.ts";

/** Apply the cellular payload limit before the endpoint decodes its JSON body. */
export const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const authenticate = yield* EnvironmentAuthenticatedAuth;
    return (handler, metadata) =>
      authenticate(handler, metadata).pipe(
        Effect.provideService(
          HttpIncomingMessage.MaxBodySize,
          ByteSize.bytes(WATCH_MAX_BODY_BYTES),
        ),
      );
  }),
).pipe(Layer.provide(WatchAuthHttp.layerAuthenticatedAuth));

const mapErrors = <A, R>(
  effect: Effect.Effect<A, WatchService.WatchServiceError | WatchService.WatchStorageError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      WatchServiceError: (error) =>
        Effect.fail(new WatchRequestError({ code: error.code, message: error.message })),
      WatchStorageError: (cause) => failEnvironmentInternal("internal_error", cause),
    }),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "watch",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* WatchService.WatchService;
    return handlers
      .handle(
        "capabilities",
        Effect.fnUntraced(function* () {
          yield* currentWatchPrincipal();
          return yield* service.capabilities();
        }),
      )
      .handle(
        "threads",
        Effect.fnUntraced(function* ({ query }) {
          const principal = yield* currentWatchPrincipal();
          return yield* mapErrors(
            service.listThreads({
              ...query,
              limit: query.limit ?? WATCH_DEFAULT_THREAD_PAGE_SIZE,
              restriction: principal.restriction,
            }),
          );
        }),
      )
      .handle(
        "thread",
        Effect.fnUntraced(function* ({ params }) {
          const principal = yield* currentWatchPrincipal();
          return yield* mapErrors(
            service.getThread({ ...params, restriction: principal.restriction }),
          );
        }),
      )
      .handle(
        "command",
        Effect.fnUntraced(function* ({ payload }) {
          const principal = yield* currentWatchPrincipal(AuthOrchestrationOperateScope);
          return yield* mapErrors(
            service.submitCommand({
              envelope: payload,
              principal: principal.sessionId,
              restriction: principal.restriction,
            }),
          );
        }),
      )
      .handle(
        "commandReceipt",
        Effect.fnUntraced(function* ({ params }) {
          const principal = yield* currentWatchPrincipal();
          return yield* mapErrors(
            service.getReceipt({
              ...params,
              principal: principal.sessionId,
              restriction: principal.restriction,
            }),
          );
        }),
      );
  }),
);
