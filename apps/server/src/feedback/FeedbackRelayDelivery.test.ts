import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as FeedbackRelayDelivery from "./FeedbackRelayDelivery.ts";
import type { FeedbackReport } from "./FeedbackReport.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const sampleReport: Omit<FeedbackReport, "sent"> = {
  id: "01990000-0000-7000-8000-000000000099",
  threadId: "thread-private-id",
  createdAt: "2026-11-24T01:02:03.000Z",
  kind: "bug",
  subject: "t3_thread_read",
  expected: "Returns items.",
  actual: "Empty list.",
  workaround: "",
  userRequested: true,
  source: "mcp",
  trace: {
    turns: 1,
    textTurns: 0,
    truncated: false,
    entries: [{ turn: 1, type: "user", length: 5 }],
  },
};

function makeSecretLayer(secrets: Readonly<Record<string, string>>) {
  return Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) =>
      Effect.succeed(
        name in secrets ? Option.some(new TextEncoder().encode(secrets[name]!)) : Option.none(),
      ),
  });
}

function makeLayer(options: {
  readonly policy?: ManagedPolicyDocument;
  readonly env?: NodeJS.ProcessEnv;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
}) {
  const requests: Array<{
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body: Record<string, unknown>;
  }> = [];
  const execute =
    options.execute ??
    ((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true, duplicate: false }), { status: 200 }),
        ),
      ));
  const client = HttpClient.make((request) => {
    const body =
      request.body._tag === "Uint8Array"
        ? (decodeJson(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
        : {};
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });
    return execute(request);
  });

  const layer = FeedbackRelayDelivery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-feedback-delivery-" }),
        ManagedPolicy.layerTest(options.policy),
        Layer.succeed(HostProcess.Environment, options.env ?? {}),
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Architecture, "x64"),
        makeSecretLayer(
          options.secrets ?? {
            [RELAY_URL_SECRET]: "https://relay.s2code.dev",
            [RELAY_ENVIRONMENT_CREDENTIAL_SECRET]: "t3env_secret_token",
          },
        ),
        Layer.succeed(HttpClient.HttpClient, client),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return { layer, requests };
}

it.effect(
  "skips delivery with zero HTTP calls when denied by policy, env opt-out, unlinked, or upstream URL",
  () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Parameters<typeof makeLayer>[0]> = [
        {
          policy: {
            schemaVersion: 1,
            organization: "Acme",
            limits: { telemetry: false },
          },
        },
        { env: { T3CODE_TELEMETRY_ENABLED: "false" } },
        { env: { T3CODE_TELEMETRY_ENABLED: "0" } },
        { env: { T3CODE_TELEMETRY_ENABLED: "off" } },
        { env: { T3CODE_TELEMETRY_ENABLED: "no" } },
        { env: { T3CODE_TELEMETRY_ENABLED: "N" } },
        { secrets: {} },
        {
          secrets: {
            [RELAY_URL_SECRET]: "https://relay.t3.codes",
            [RELAY_ENVIRONMENT_CREDENTIAL_SECRET]: "t3env_secret_token",
          },
        },
      ];
      for (const config of cases) {
        const { layer, requests } = makeLayer(config);
        const sent = yield* Effect.gen(function* () {
          const delivery = yield* FeedbackRelayDelivery.FeedbackRelayDelivery;
          return yield* delivery.deliver(sampleReport, { provider: "codex", model: "gpt-5.5" });
        }).pipe(Effect.provide(layer));
        expect(sent).toBe(false);
        expect(requests).toEqual([]);
      }
    }),
);

it.effect("delivers to linked fork relay when telemetry env is unset and omits private IDs", () =>
  Effect.gen(function* () {
    const { layer, requests } = makeLayer({ env: {} });
    const sent = yield* Effect.gen(function* () {
      const delivery = yield* FeedbackRelayDelivery.FeedbackRelayDelivery;
      return yield* delivery.deliver(sampleReport, { provider: "codex", model: "gpt-5.5" });
    }).pipe(Effect.provide(layer));

    expect(sent).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://relay.s2code.dev/v1/feedback");
    expect(requests[0]!.authorization).toBe("Bearer t3env_secret_token");
    expect(requests[0]!.body).toMatchObject({
      id: sampleReport.id,
      createdAt: sampleReport.createdAt,
      kind: "bug",
      subject: "t3_thread_read",
      expected: "Returns items.",
      actual: "Empty list.",
      workaround: "",
      userRequested: true,
      source: "mcp",
      provider: "codex",
      model: "gpt-5.5",
      telemetryChannel: "dev",
      serverOs: "Linux",
      serverArch: "x64",
      serverMode: "web",
    });
    expect("threadId" in requests[0]!.body).toBe(false);
    expect("projectId" in requests[0]!.body).toBe(false);
    expect("distinctId" in requests[0]!.body).toBe(false);
    expect("installId" in requests[0]!.body).toBe(false);
  }),
);

it.effect("retries once on 503/429/404/transport/timeout and does not retry on 400/401/413", () =>
  Effect.gen(function* () {
    for (const status of [503, 429, 404]) {
      let attempt = 0;
      const firstCalled = yield* Deferred.make<void>();
      const { layer, requests } = makeLayer({
        execute: (request) => {
          attempt += 1;
          const current = attempt;
          return (current === 1 ? Deferred.succeed(firstCalled, undefined) : Effect.void).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(current === 1 ? "" : JSON.stringify({ ok: true, duplicate: false }), {
                  status: current === 1 ? status : 200,
                }),
              ),
            ),
          );
        },
      });
      yield* Effect.gen(function* () {
        const delivery = yield* FeedbackRelayDelivery.FeedbackRelayDelivery;
        const fiber = yield* Effect.forkChild(delivery.deliver(sampleReport, {}));
        yield* Deferred.await(firstCalled);
        yield* TestClock.adjust("500 millis");
        expect(yield* Fiber.join(fiber)).toBe(true);
      }).pipe(Effect.provide(layer));
      expect(requests).toHaveLength(2);
    }

    // Transport error retries once and succeeds on second attempt.
    let transportAttempt = 0;
    const transportFirstCalled = yield* Deferred.make<void>();
    const transport = makeLayer({
      execute: (request) => {
        transportAttempt += 1;
        if (transportAttempt === 1) {
          return Deferred.succeed(transportFirstCalled, undefined).pipe(
            Effect.andThen(
              Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error("ECONNRESET"),
                  }),
                }),
              ),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ ok: true, duplicate: false }), { status: 200 }),
          ),
        );
      },
    });
    yield* Effect.gen(function* () {
      const delivery = yield* FeedbackRelayDelivery.FeedbackRelayDelivery;
      const fiber = yield* Effect.forkChild(delivery.deliver(sampleReport, {}));
      yield* Deferred.await(transportFirstCalled);
      yield* TestClock.adjust("500 millis");
      expect(yield* Fiber.join(fiber)).toBe(true);
    }).pipe(Effect.provide(transport.layer));
    expect(transport.requests).toHaveLength(2);

    // Timeout retries once and returns false if both attempts hang past 4 s.
    let hangAttempt = 0;
    const hangFirst = yield* Deferred.make<void>();
    const hangSecond = yield* Deferred.make<void>();
    const hanging = makeLayer({
      execute: () => {
        hangAttempt += 1;
        const signal = hangAttempt === 1 ? hangFirst : hangSecond;
        return Deferred.succeed(signal, undefined).pipe(Effect.andThen(Effect.never));
      },
    });
    yield* Effect.gen(function* () {
      const delivery = yield* FeedbackRelayDelivery.FeedbackRelayDelivery;
      const fiber = yield* Effect.forkChild(delivery.deliver(sampleReport, {}));
      yield* Deferred.await(hangFirst);
      yield* TestClock.adjust("4 seconds");
      yield* TestClock.adjust("500 millis");
      yield* Deferred.await(hangSecond);
      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(fiber)).toBe(false);
    }).pipe(Effect.provide(hanging.layer));
    expect(hanging.requests).toHaveLength(2);

    // Non-retryable client rejections return false immediately without retrying.
    for (const status of [400, 401, 413]) {
      const { layer, requests } = makeLayer({
        execute: (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status }))),
      });
      const sent = yield* Effect.gen(function* () {
        const delivery = yield* FeedbackRelayDelivery.FeedbackRelayDelivery;
        return yield* delivery.deliver(sampleReport, {});
      }).pipe(Effect.provide(layer));
      expect(sent).toBe(false);
      expect(requests).toHaveLength(1);
    }

    // 200 OK with HTML (e.g. captive portal / Access login) or invalid JSON returns false without retrying.
    for (const body of ["<html><body>Sign in</body></html>", '{"ok":false}']) {
      const { layer, requests } = makeLayer({
        execute: (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))),
      });
      const sent = yield* Effect.gen(function* () {
        const delivery = yield* FeedbackRelayDelivery.FeedbackRelayDelivery;
        return yield* delivery.deliver(sampleReport, {});
      }).pipe(Effect.provide(layer));
      expect(sent).toBe(false);
      expect(requests).toHaveLength(1);
    }
  }),
);
