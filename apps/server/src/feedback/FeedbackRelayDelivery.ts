import type { ClientOs } from "@t3tools/contracts";
import {
  RelayAgentFeedbackResponse,
  type RelayAgentFeedbackRequest,
} from "@t3tools/contracts/relay";
import { forkHostedOrigin } from "@t3tools/shared/hostedConfig";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import type { ProviderDimensions } from "../telemetry/ProviderDimensions.ts";
import type { FeedbackReport } from "./FeedbackReport.ts";

const DELIVERY_TIMEOUT = Duration.seconds(4);
const RETRY_DELAY = Duration.millis(500);
const NON_RETRYABLE_STATUSES = new Set([400, 401, 413]);
const TELEMETRY_OPT_OUT_VALUES = new Set(["false", "0", "no", "off", "n"]);
const decodeFeedbackResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentFeedbackResponse),
);

function serverOsFromNodePlatform(platform: string): ClientOs {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    default:
      return "other";
  }
}

function isExplicitTelemetryOptOut(value: string | undefined): boolean {
  if (value === undefined) return false;
  return TELEMETRY_OPT_OUT_VALUES.has(value.trim().toLowerCase());
}

function isRetryableStatus(status: number): boolean {
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  return status === 404 || status === 429 || status >= 500;
}

export class FeedbackRelayDelivery extends Context.Service<
  FeedbackRelayDelivery,
  {
    /** Delivers a scrubbed report to the linked S2 Connect relay; never fails. */
    readonly deliver: (
      report: Omit<FeedbackReport, "sent">,
      dimensions: Partial<ProviderDimensions>,
    ) => Effect.Effect<boolean>;
  }
>()("t3/feedback/FeedbackRelayDelivery") {}

const make = Effect.gen(function* () {
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  const allowLoopback = ServerConfig.telemetryChannel === "dev";

  const sendOnce = Effect.fn("FeedbackRelayDelivery.sendOnce")(function* (
    url: string,
    credential: string,
    payload: RelayAgentFeedbackRequest,
  ) {
    return yield* Effect.gen(function* () {
      const request = yield* HttpClientRequest.post(`${url}/v1/feedback`, {
        headers: {
          authorization: `Bearer ${credential}`,
        },
      }).pipe(HttpClientRequest.bodyJson(payload));

      const executed = yield* Effect.gen(function* () {
        const response = yield* httpClient.execute(request);
        if (response.status === 200) {
          const text = yield* response.text;
          return Option.isSome(decodeFeedbackResponse(text))
            ? ({ kind: "ok" } as const)
            : ({ kind: "invalid_response" } as const);
        }
        yield* response.text.pipe(Effect.ignore);
        return { kind: "status", status: response.status } as const;
      }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeoutOption(DELIVERY_TIMEOUT),
      );
      if (Option.isNone(executed)) {
        return { kind: "timeout" as const };
      }
      return executed.value;
    }).pipe(
      Effect.result,
      Effect.map((result) =>
        Result.isFailure(result) ? { kind: "transport_error" as const } : result.success,
      ),
    );
  });

  const deliver: FeedbackRelayDelivery["Service"]["deliver"] = Effect.fn(
    "FeedbackRelayDelivery.deliver",
  )(function* (report, dimensions) {
    if (ManagedPolicy.deniedBy(managedPolicy, "telemetry") !== undefined) {
      return false;
    }
    if (isExplicitTelemetryOptOut(hostEnvironment.T3CODE_TELEMETRY_ENABLED)) {
      return false;
    }
    const connection = yield* readRelayConnection.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    if (connection === null) {
      return false;
    }
    const relayOrigin = forkHostedOrigin(connection.url, allowLoopback);
    if (relayOrigin === null) {
      yield* Effect.logWarning("Skipping agent feedback delivery to disallowed relay origin", {
        reportId: report.id,
      });
      return false;
    }

    const payload: RelayAgentFeedbackRequest = {
      id: report.id,
      createdAt: report.createdAt,
      kind: report.kind,
      subject: report.subject,
      expected: report.expected,
      actual: report.actual,
      workaround: report.workaround,
      userRequested: report.userRequested,
      source: report.source,
      trace: report.trace,
      ...(dimensions.provider ? { provider: dimensions.provider } : {}),
      ...(dimensions.model ? { model: dimensions.model } : {}),
      serverVersion: packageJson.version,
      telemetryChannel: ServerConfig.telemetryChannel,
      serverOs: serverOsFromNodePlatform(hostPlatform),
      serverArch: hostArchitecture,
      serverMode: serverConfig.mode,
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const outcome = yield* sendOnce(relayOrigin, connection.environmentCredential, payload);
      if (outcome.kind === "ok") {
        return true;
      }
      const retryable =
        outcome.kind === "timeout" ||
        outcome.kind === "transport_error" ||
        (outcome.kind === "status" && isRetryableStatus(outcome.status));
      if (attempt === 1 && retryable) {
        yield* Effect.sleep(RETRY_DELAY);
        continue;
      }
      yield* Effect.logWarning("Agent feedback relay delivery failed", {
        reportId: report.id,
        reason: outcome.kind === "status" ? `http_${outcome.status}` : outcome.kind,
      });
      return false;
    }
    return false;
  });

  return FeedbackRelayDelivery.of({ deliver });
});

export const layer = Layer.effect(FeedbackRelayDelivery, make);
