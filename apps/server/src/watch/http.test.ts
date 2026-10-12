import { assert, test } from "vite-plus/test";
import { makeMethods } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as WatchHttp from "./http.ts";

const it = makeMethods(test);

it.effect("accepts Watch audio above the command body cap over a real Node socket", () =>
  Effect.gen(function* () {
    const audioBase64 = Buffer.alloc(100_000).toString("base64");
    const routes = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        const handler = yield* HttpApiBuilder.endpoint(
          EnvironmentHttpApi,
          "watch",
          "transcription",
          ({ payload }) => {
            assert.equal(payload.audioBase64, audioBase64);
            return Effect.succeed({ text: "Uploaded recording." });
          },
        );
        yield* router.add("POST", "/api/watch/v1/threads/:threadId/transcription", handler);
      }),
    ).pipe(
      Layer.provide(
        WatchHttp.layerAuthenticatedAuth.pipe(
          Layer.provide(
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              authenticateWatchClient: () =>
                Effect.succeed({
                  sessionId: AuthSessionId.make("watch-upload"),
                  subject: "watch-client",
                  method: "bearer-access-token",
                  scopes: [AuthOrchestrationOperateScope],
                  restriction: {},
                }),
            }),
          ),
        ),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const response = yield* client.execute(
      HttpClientRequest.post("/api/watch/v1/threads/test/transcription").pipe(
        HttpClientRequest.bodyJsonUnsafe({ audioBase64, locale: "en-US" }),
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(yield* response.json, { text: "Uploaded recording." });
  }).pipe(Effect.scoped),
);
