import type { SDKModel, SDKUser } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";

const user = {
  apiKeyName: "test-key",
  userEmail: "cursor@example.com",
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies SDKUser;

const model = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  parameters: [],
} satisfies SDKModel;

const catalogError = (retryable = false) =>
  new CursorSdkCatalog.CursorSdkCatalogError({
    authenticationFailure: false,
    retryable,
    cause: new Error("catalog unavailable"),
  });

describe("CursorSdkCatalog", () => {
  it.effect("does not cache failed or empty model discovery", () =>
    Effect.gen(function* () {
      let modelCalls = 0;
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () => Effect.succeed(user),
        readModels: () =>
          Effect.suspend(() => {
            modelCalls += 1;
            if (modelCalls === 1) return Effect.fail(catalogError());
            if (modelCalls === 2) return Effect.succeed([]);
            return Effect.succeed([model]);
          }),
      });

      expect(Exit.isFailure(yield* Effect.exit(catalog.read("test-key")))).toBe(true);
      expect((yield* catalog.read("test-key")).models).toEqual([]);
      expect((yield* catalog.read("test-key")).models).toEqual([model]);
      expect((yield* catalog.read("test-key")).models).toEqual([model]);
      expect(modelCalls).toBe(3);
    }),
  );

  it.effect("retries transient network failures before reporting the catalog unavailable", () =>
    Effect.gen(function* () {
      let userCalls = 0;
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () =>
          Effect.suspend(() => {
            userCalls += 1;
            return userCalls < 3 ? Effect.fail(catalogError(true)) : Effect.succeed(user);
          }),
        readModels: () => Effect.succeed([model]),
      });

      const fiber = yield* Effect.forkChild(catalog.read("test-key"));
      yield* TestClock.adjust("10 seconds");

      expect((yield* Fiber.join(fiber)).user).toEqual(user);
      expect(userCalls).toBe(3);
    }),
  );

  it.effect("does not retry non-transient failures", () =>
    Effect.gen(function* () {
      let userCalls = 0;
      const catalog = yield* CursorSdkCatalog.makeCursorSdkCatalog({
        readUser: () => Effect.suspend(() => ((userCalls += 1), Effect.fail(catalogError()))),
        readModels: () => Effect.succeed([model]),
      });

      expect(Exit.isFailure(yield* Effect.exit(catalog.read("test-key")))).toBe(true);
      expect(userCalls).toBe(1);
    }),
  );
});
