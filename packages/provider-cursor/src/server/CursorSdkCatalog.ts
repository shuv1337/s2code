import type { SDKModel, SDKUser } from "@cursor/sdk";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { AuthenticationError, Cursor, CursorSdkError } from "./sdk.ts";

export interface CursorSdkCatalogSnapshot {
  readonly user: SDKUser;
  readonly models: ReadonlyArray<SDKModel>;
}

export class CursorSdkCatalogError extends Schema.TaggedError<CursorSdkCatalogError>()(
  "CursorSdkCatalogError",
  {
    authenticationFailure: Schema.Boolean,
    retryable: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.authenticationFailure
      ? "Cursor SDK authentication failed."
      : "Cursor SDK catalog request failed.";
  }

  get planRequired(): boolean {
    return this.cause instanceof CursorSdkError && this.cause.code === "plan_required";
  }
}

export class CursorSdkCatalog extends Context.Service<
  CursorSdkCatalog,
  {
    readonly read: (
      apiKey: string,
    ) => Effect.Effect<CursorSdkCatalogSnapshot, CursorSdkCatalogError>;
  }
>()("@t3tools/provider-cursor/server/CursorSdkCatalog") {}

function isAuthenticationFailure(cause: unknown): boolean {
  return (
    cause instanceof AuthenticationError ||
    (cause instanceof CursorSdkError && cause.status === 401)
  );
}

export interface CursorSdkCatalogProbes {
  readonly readUser: (apiKey: string) => Effect.Effect<SDKUser, CursorSdkCatalogError>;
  readonly readModels: (
    apiKey: string,
  ) => Effect.Effect<ReadonlyArray<SDKModel>, CursorSdkCatalogError>;
}

const sdkRequest = <A>(tryRequest: () => Promise<A>) =>
  Effect.tryPromise({
    try: tryRequest,
    catch: (cause) => {
      const authenticationFailure = isAuthenticationFailure(cause);
      return new CursorSdkCatalogError({
        authenticationFailure,
        retryable: !authenticationFailure && cause instanceof CursorSdkError && cause.isRetryable,
        cause,
      });
    },
  });

// A probe that races network bring-up at boot would otherwise publish a failed
// status that only clears on the next foreground-gated health refresh.
const retryTransientFailures = <A>(effect: Effect.Effect<A, CursorSdkCatalogError>) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error.retryable,
      schedule: Schedule.exponential("500 millis"),
      times: 4,
    }),
  );

const liveProbes: CursorSdkCatalogProbes = {
  readUser: (apiKey) => sdkRequest(() => Cursor.me({ apiKey })),
  readModels: (apiKey) => sdkRequest(() => Cursor.models.list({ apiKey })),
};

export const makeCursorSdkCatalog = Effect.fn("CursorSdkCatalog.make")(function* (
  probes: CursorSdkCatalogProbes = liveProbes,
) {
  const modelCache = yield* Cache.makeWith(probes.readModels, {
    capacity: 32,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(30) : Duration.zero,
  });
  return CursorSdkCatalog.of({
    read: Effect.fn("CursorSdkCatalog.read")(function (apiKey) {
      return Effect.all(
        {
          user: retryTransientFailures(probes.readUser(apiKey)),
          models: retryTransientFailures(Cache.get(modelCache, apiKey)),
        },
        { concurrency: "unbounded" },
      );
    }),
  });
});

export const layer = Layer.effect(CursorSdkCatalog, makeCursorSdkCatalog());

export function layerTest(
  read: CursorSdkCatalog["Service"]["read"],
): Layer.Layer<CursorSdkCatalog> {
  return Layer.succeed(CursorSdkCatalog, CursorSdkCatalog.of({ read }));
}
