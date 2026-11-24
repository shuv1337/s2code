import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { relayLayer } from "./relayTracing.ts";

const tracesTo = (policy?: ManagedPolicyDocument) =>
  Effect.service(RelayTracing.RelayClientTracer).pipe(
    Effect.provide(
      relayLayer(
        { serviceName: "t3code-server", runtime: "node", client: "environment-server" },
        { tracesUrl: "https://traces.example.com", tracesDataset: "relay", tracesToken: "token" },
      ).pipe(
        Layer.provide(ManagedPolicy.layerTest(policy)),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-relay-tracing-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Effect.map(Option.isSome),
  );

it.effect("never provides a relay tracer with or without a managed policy", () =>
  Effect.gen(function* () {
    assert.isFalse(yield* tracesTo());
    assert.isFalse(
      yield* tracesTo({
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { telemetry: false },
      }),
    );
  }),
);
