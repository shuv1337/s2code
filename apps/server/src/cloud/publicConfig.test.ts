import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  hostedAppUrlConfig,
  isCloudPublicConfigConfigured,
  makeCloudCliOAuthConfig,
  makeOptionalHostedAppUrlConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("has no upstream hosted default and rejects upstream runtime relay overrides", () =>
  Effect.gen(function* () {
    assert.isTrue(Result.isFailure(yield* hostedAppUrlConfig.pipe(provideEnv({}), Effect.result)));
    assert.equal(
      yield* hostedAppUrlConfig.pipe(provideEnv({ T3CODE_HOSTED_APP_URL: "https://fork.test" })),
      "https://fork.test",
    );
    assert.isTrue(
      Result.isFailure(
        yield* makeRelayUrlConfig("https://fork.test").pipe(
          provideEnv({ T3CODE_RELAY_URL: "https://relay.t3.codes" }),
          Effect.result,
        ),
      ),
    );
  }),
);

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "app.t3.codes",
      "http://app.t3.codes",
      "https://app.t3.codes/nested",
      "https://app.t3.codes?alias=true",
      "https://app.t3.codes",
    ]) {
      const result = yield* hostedAppUrlConfig.pipe(
        provideEnv({ T3CODE_HOSTED_APP_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);

it.effect("derives direct Clerk OAuth endpoints from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      tokenEndpoint: "https://clerk.example.test/oauth/token",
      deviceAuthorizationEndpoint: "https://clerk.example.test/oauth/device_authorization",
      clientId: "oauth_client_embedded",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
  }),
);

it.effect(
  "optionalHostedAppUrlConfig returns None only when unset/blank and rejects invalid or upstream URLs",
  () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* makeOptionalHostedAppUrlConfig("").pipe(provideEnv({}))));
      assert.isTrue(
        Option.isNone(
          yield* makeOptionalHostedAppUrlConfig("").pipe(
            provideEnv({ T3CODE_HOSTED_APP_URL: "   " }),
          ),
        ),
      );
      assert.deepEqual(
        yield* makeOptionalHostedAppUrlConfig("").pipe(
          provideEnv({ T3CODE_HOSTED_APP_URL: "https://app.fork.test" }),
        ),
        Option.some("https://app.fork.test"),
      );
      assert.deepEqual(
        yield* makeOptionalHostedAppUrlConfig("https://embedded.fork.test").pipe(provideEnv({})),
        Option.some("https://embedded.fork.test"),
      );
      for (const bad of ["https://app.t3.codes", "http://app.fork.test", "not-a-url"]) {
        const result = yield* makeOptionalHostedAppUrlConfig("").pipe(
          provideEnv({ T3CODE_HOSTED_APP_URL: bad }),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result), bad);
      }
    }),
);

it("requires a pinned mint public key and does not require a hosted app URL", () => {
  const validBase = {
    T3CODE_RELAY_URL: "https://relay.fork.test",
    T3CODE_CLOUD_MINT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\\nKEY\\n-----END PUBLIC KEY-----",
    T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("clerk.fork.test$")}`,
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_123",
  };

  assert.isTrue(isCloudPublicConfigConfigured(validBase, {}));
  assert.isFalse(
    isCloudPublicConfigConfigured(
      {
        ...validBase,
        T3CODE_CLOUD_MINT_PUBLIC_KEY: "",
        T3CODE_HOSTED_APP_URL: "https://app.fork.test",
      },
      {},
    ),
  );
  assert.isFalse(
    isCloudPublicConfigConfigured({ ...validBase, T3CODE_RELAY_URL: "https://relay.t3.codes" }, {}),
  );
  assert.isTrue(
    isCloudPublicConfigConfigured(
      {},
      {
        relayUrl: validBase.T3CODE_RELAY_URL,
        cloudMintPublicKey: validBase.T3CODE_CLOUD_MINT_PUBLIC_KEY,
        clerkPublishableKey: validBase.T3CODE_CLERK_PUBLISHABLE_KEY,
        clerkCliOAuthClientId: validBase.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID,
      },
    ),
  );
});

it("product opt-out disables relay tracing with either built-in or runtime credentials", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };
  const env = {
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "false",
  };

  assert.equal(resolveRelayClientTracingConfig(env, fallback), null);
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        ...env,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
