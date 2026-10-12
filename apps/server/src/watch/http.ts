import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedAuth,
  WATCH_MAX_BODY_BYTES,
  EnvironmentHttpApi,
  WatchPairingBodyLimit,
  WatchRequestError,
  WATCH_DEFAULT_THREAD_PAGE_SIZE,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { failEnvironmentInternal } from "../auth/http.ts";
import * as WatchPairingStore from "../auth/WatchPairingStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { currentWatchPrincipal } from "./principal.ts";
import * as WatchService from "./WatchService.ts";
import * as WatchAuthHttp from "../auth/WatchHttp.ts";

const withWatchBodyLimit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(WATCH_MAX_BODY_BYTES)),
  );

/** Apply the cellular payload limit before the endpoint decodes its JSON body. */
export const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const authenticate = yield* EnvironmentAuthenticatedAuth;
    return (handler, metadata) => withWatchBodyLimit(authenticate(handler, metadata));
  }),
).pipe(Layer.provide(WatchAuthHttp.layerAuthenticatedAuth));

const layerPairingBodyLimit = Layer.succeed(WatchPairingBodyLimit, withWatchBodyLimit);

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

const mapPairingErrors = <A, R>(
  effect: Effect.Effect<
    A,
    WatchPairingStore.WatchPairingError | WatchPairingStore.WatchPairingStorageError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      WatchPairingError: (error) =>
        Effect.fail(new WatchRequestError({ code: error.code, message: error.message })),
      WatchPairingStorageError: (cause) => failEnvironmentInternal("internal_error", cause),
    }),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "watch",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* WatchService.WatchService;
    const pairing = yield* WatchPairingStore.WatchPairingStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
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
      )
      .handle(
        "pairingStart",
        Effect.fnUntraced(function* ({ payload }) {
          const started = yield* mapPairingErrors(
            pairing.start(
              payload.clientLabel === undefined ? {} : { clientLabel: payload.clientLabel },
            ),
          );
          const descriptor = yield* environment.getDescriptor;
          return {
            ...started,
            environment: { id: descriptor.environmentId, label: descriptor.label },
          };
        }),
      )
      .handle(
        "pairingToken",
        Effect.fnUntraced(function* ({ payload }) {
          return yield* mapPairingErrors(pairing.poll({ deviceCode: payload.deviceCode }));
        }),
      );
  }),
).pipe(Layer.provideMerge(layerPairingBodyLimit));
