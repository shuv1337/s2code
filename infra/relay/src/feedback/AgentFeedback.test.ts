import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi, type RelayAgentFeedbackRequest } from "@t3tools/contracts/relay";
import { drizzle } from "drizzle-orm/pglite";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as RelayDb from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import { RELAY_HTTP_ROUTER_CONFIG } from "../http/Api.ts";
import * as RelayHttpApi from "../http/Api.ts";
import * as AgentFeedback from "./AgentFeedback.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const VALID_TOKEN = "t3env_valid_credential";
const OTHER_TOKEN = "t3env_other_credential";
const SECRET_ENV_ID = "env-secret-private-id-12345";

function makeFeedbackPayload(
  overrides: Partial<RelayAgentFeedbackRequest> = {},
): RelayAgentFeedbackRequest {
  return {
    id: "01990000-0000-7000-8000-000000000001",
    createdAt: "2026-11-24T00:00:00.000Z",
    kind: "bug",
    subject: "t3_thread_read",
    expected: "Return thread items.",
    actual: "Returned empty list.",
    workaround: "Retried with limit 10.",
    userRequested: true,
    source: "mcp",
    trace: {
      turns: 2,
      textTurns: 1,
      truncated: false,
      entries: [
        {
          turn: 1,
          type: "user",
          length: 25,
          text: "PRIVATE_CONVERSATION_CANARY_USER_MESSAGE",
        },
        {
          turn: 1,
          type: "tool",
          tool: "t3_thread_read",
          outcome: "error",
          durationMs: 420,
        },
        {
          turn: 2,
          type: "assistant",
          length: 19,
          text: "PRIVATE_CONVERSATION_CANARY_ASSISTANT_REPLY",
        },
      ],
    },
    provider: "codex",
    model: "gpt-5.5",
    serverVersion: "0.1.99",
    telemetryChannel: "nightly",
    serverOs: "Linux",
    serverArch: "x64",
    serverMode: "desktop",
    ...overrides,
  };
}

/**
 * Wraps a PGlite Drizzle client so every fluent Drizzle query (`select`, `insert`, `update`,
 * `execute`) resolves as an Effect matching `drizzle-orm/effect-postgres`.
 */
function wrapEffectPg(pg: PGlite): RelayDb.RelayDb["Service"] {
  const db = drizzle({ client: pg });
  const wrapChain = (target: unknown): unknown =>
    new Proxy(target as object, {
      get(obj, prop, receiver) {
        if (prop === "then") return undefined;
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: ReadonlyArray<unknown>) => {
          const next = value.apply(obj, args);
          if (next !== null && (typeof next === "object" || typeof next === "function")) {
            return wrapBuilder(next);
          }
          return next;
        };
      },
    });
  const wrapBuilder = (builder: unknown): unknown => {
    const asEffect = () => Effect.promise(() => Promise.resolve(builder as PromiseLike<unknown>));
    return new Proxy(asEffect(), {
      get(effectTarget, prop, receiver) {
        if (
          typeof prop === "string" &&
          typeof (builder as Record<string, unknown>)[prop] === "function" &&
          prop !== "then" &&
          prop !== "catch" &&
          prop !== "finally"
        ) {
          return (...args: ReadonlyArray<unknown>) =>
            wrapBuilder(
              (builder as Record<string, (...a: ReadonlyArray<unknown>) => unknown>)[prop]!(
                ...args,
              ),
            );
        }
        const value = Reflect.get(effectTarget, prop, receiver);
        return typeof value === "function" ? value.bind(effectTarget) : value;
      },
    });
  };

  return {
    select: (...args: ReadonlyArray<unknown>) =>
      wrapChain((db.select as (...a: ReadonlyArray<unknown>) => unknown)(...args)),
    insert: (...args: ReadonlyArray<unknown>) =>
      wrapChain((db.insert as (...a: ReadonlyArray<unknown>) => unknown)(...args)),
    update: (...args: ReadonlyArray<unknown>) =>
      wrapChain((db.update as (...a: ReadonlyArray<unknown>) => unknown)(...args)),
    execute: (query: unknown) =>
      Effect.promise(async () => {
        const result = await db.execute(query as never);
        return result.rows;
      }),
  } as unknown as RelayDb.RelayDb["Service"];
}

interface CapturedGithubCall {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly redirect: RequestRedirect | undefined;
  readonly body: unknown;
}

const makeHarness = (
  options: {
    readonly githubRepo?: string;
    readonly githubToken?: string | undefined;
    readonly createIssuesForAutoReports?: boolean;
    readonly executeGithub?: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
  } = {},
) =>
  Effect.gen(function* () {
    const pg = yield* Effect.acquireRelease(
      Effect.promise(() => PGlite.create()),
      (client) => Effect.promise(() => client.close()),
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationsDir = yield* path.fromFileUrl(
      new URL("../../migrations/postgres/", import.meta.url),
    );
    for (const name of (yield* fs.readDirectory(migrationsDir)).toSorted()) {
      const migration = yield* fs.readFileString(`${migrationsDir}${name}/migration.sql`);
      yield* Effect.promise(() => pg.exec(migration));
    }

    const githubCalls: Array<CapturedGithubCall> = [];
    const executeGithub =
      options.executeGithub ??
      ((request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              encodeJson({
                number: githubCalls.length,
                html_url: `https://github.com/shuv1337/s2code/issues/${githubCalls.length}`,
              }),
              { status: 201, headers: { "content-type": "application/json" } },
            ),
          ),
        ));

    const httpClient = HttpClient.make((request) =>
      Effect.withFiber((fiber) => {
        const init = Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit);
        const body =
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined;
        githubCalls.push({ request, redirect: init?.redirect, body });
        return executeGithub(request);
      }),
    );

    const layerService = AgentFeedback.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RelayDb.RelayDb, wrapEffectPg(pg)),
          Layer.succeed(AgentFeedback.AgentFeedbackSettings, {
            githubRepo: options.githubRepo ?? "shuv1337/s2code",
            githubToken:
              options.githubToken === undefined ? undefined : Redacted.make(options.githubToken),
            createIssuesForAutoReports: options.createIssuesForAutoReports ?? false,
          }),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        ),
      ),
    );

    const layerAuth = RelayHttpApi.layerEnvironmentAuth.pipe(
      Layer.provide(
        Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {
          authenticate: (token) => {
            if (token === VALID_TOKEN) {
              return Effect.succeedSome({
                credentialId: "cred-1",
                environmentId: SECRET_ENV_ID,
                environmentPublicKey: "pub-key-1",
              });
            }
            if (token === OTHER_TOKEN) {
              return Effect.succeedSome({
                credentialId: "cred-2",
                environmentId: "env-other-2",
                environmentPublicKey: "pub-key-2",
              });
            }
            return Effect.succeedNone;
          },
        }),
      ),
    );

    const httpEffect = HttpRouter.toHttpEffect(
      Layer.mergeAll(
        HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.feedback)).pipe(
          Layer.provide(AgentFeedback.layerApi.pipe(Layer.provide(layerService))),
          Layer.provide(layerAuth),
          Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
        ),
        RelayHttpApi.layerNotFoundRoute,
      ),
    ).pipe(Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG));

    const send = (request: Request) =>
      Effect.gen(function* () {
        const handler = yield* httpEffect;
        const response = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
        yield* HttpEffect.toHandled(handler, (_request, value) =>
          Deferred.succeed(response, value),
        ).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        );
        return yield* Deferred.await(response);
      });

    const service = yield* Effect.service(AgentFeedback.AgentFeedback).pipe(
      Effect.provide(layerService),
    );

    return { pg, githubCalls, send, service };
  });

const feedbackRequest = (
  body: string,
  options: { readonly token?: string | null; readonly headers?: Record<string, string> } = {},
) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? VALID_TOKEN}` }),
    ...options.headers,
  };
  return new Request("https://relay.test/v1/feedback", {
    method: "POST",
    headers,
    body,
  });
};

const readJsonBody = (response: HttpServerResponse.HttpServerResponse) => {
  const body = response.body;
  if (body._tag === "Uint8Array") {
    return decodeJson(new TextDecoder().decode(body.body));
  }
  return undefined;
};

describe("AgentFeedback", () => {
  it("formats public GitHub issues with dynamic fences and strictly without conversation text or private IDs", () => {
    const issue = AgentFeedback.formatFeedbackGithubIssue({
      id: "fb-1",
      receivedAt: "2026-11-24T01:00:00.000Z",
      createdAt: "2026-11-24T00:59:59.000Z",
      kind: "bug",
      subject: "t3_thread_read",
      expected: "Should handle ```fenced``` blocks safely",
      actual: "Broke on ````four-backtick```` fence",
      workaround: "Used `inline`",
      userRequested: true,
      source: "mcp",
      traceJson: makeFeedbackPayload().trace,
      provider: "codex",
      model: "gpt-5.5",
      serverVersion: "0.1.99",
      telemetryChannel: "nightly",
      serverOs: "Linux",
      serverArch: "x64",
      serverMode: "desktop",
    });

    expect(issue.title).toBe("Agent feedback: bug · t3_thread_read");
    expect(issue.labels).toEqual(["agent-feedback"]);
    expect(issue.body).toContain("<!-- s2code-feedback-id: fb-1 -->");
    expect(issue.body).toContain("````text\nShould handle ```fenced``` blocks safely\n````");
    expect(issue.body).toContain("`````text\nBroke on ````four-backtick```` fence\n`````");
    expect(issue.body).toContain("turn 1 · user · 25 chars");
    expect(issue.body).toContain("turn 1 · tool · t3_thread_read · error · 420ms");
    expect(issue.body).toContain("turn 2 · assistant · 19 chars");
    expect(issue.body).not.toContain("PRIVATE_CONVERSATION_CANARY");
    expect(issue.body).not.toContain(SECRET_ENV_ID);
  });

  it.effect(
    "enforces RelayEnvironmentAuth, body cap, validation, deduplication, and hourly rate limit",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const payload = makeFeedbackPayload();

        // Missing and invalid bearer tokens are rejected with 401.
        const unauth = yield* harness.send(feedbackRequest(encodeJson(payload), { token: null }));
        expect(unauth.status).toBe(401);
        const badToken = yield* harness.send(
          feedbackRequest(encodeJson(payload), { token: "t3env_wrong" }),
        );
        expect(badToken.status).toBe(401);

        // Oversized content-length and oversized body stream return 413.
        const largeHeader = yield* harness.send(
          feedbackRequest("{}", {
            headers: { "content-length": String(AgentFeedback.AGENT_FEEDBACK_MAX_BODY_BYTES + 1) },
          }),
        );
        expect(largeHeader.status).toBe(413);
        const largeBody = yield* harness.send(
          feedbackRequest("x".repeat(AgentFeedback.AGENT_FEEDBACK_MAX_BODY_BYTES + 1)),
        );
        expect(largeBody.status).toBe(413);

        // Invalid JSON, invalid subject, and oversized trace return 400.
        expect((yield* harness.send(feedbackRequest("{not-json"))).status).toBe(400);
        expect(
          (yield* harness.send(
            feedbackRequest(encodeJson(makeFeedbackPayload({ subject: "bad\nsubject" }))),
          )).status,
        ).toBe(400);
        expect(
          (yield* harness.send(
            feedbackRequest(
              encodeJson(
                makeFeedbackPayload({
                  trace: {
                    turns: 1,
                    textTurns: 0,
                    truncated: false,
                    entries: Array.from({ length: 81 }, () => ({ turn: 1, type: "user" as const })),
                  },
                }),
              ),
            ),
          )).status,
        ).toBe(400);

        // First valid submission succeeds and stores full trace privately in Postgres.
        const first = yield* harness.send(feedbackRequest(encodeJson(payload)));
        expect(first.status).toBe(200);
        expect(readJsonBody(first)).toEqual({ ok: true, duplicate: false });

        // Duplicate submission returns duplicate: true.
        const dup = yield* harness.send(feedbackRequest(encodeJson(payload)));
        expect(dup.status).toBe(200);
        expect(readJsonBody(dup)).toEqual({ ok: true, duplicate: true });

        // Unprompted report defaults to github_issue_state = 'none'.
        const autoPayload = makeFeedbackPayload({
          id: "01990000-0000-7000-8000-000000000002",
          userRequested: false,
          trace: null,
        });
        expect((yield* harness.send(feedbackRequest(encodeJson(autoPayload)))).status).toBe(200);

        const stored = yield* Effect.promise(() =>
          harness.pg.query<{
            readonly id: string;
            readonly environment_id: string;
            readonly github_issue_state: string;
            readonly trace_json: unknown;
          }>(
            "SELECT id, environment_id, github_issue_state, trace_json FROM agent_feedback ORDER BY id",
          ),
        );
        expect(stored.rows).toHaveLength(2);
        expect(stored.rows[0]).toMatchObject({
          id: payload.id,
          environment_id: SECRET_ENV_ID,
          github_issue_state: "pending",
        });
        expect(JSON.stringify(stored.rows[0]!.trace_json)).toContain(
          "PRIVATE_CONVERSATION_CANARY_USER_MESSAGE",
        );
        expect(stored.rows[1]).toMatchObject({
          id: autoPayload.id,
          github_issue_state: "none",
        });

        // Fill up to 30 reports in the current hour, then 31st returns 429 with Retry-After.
        for (let i = 3; i <= 30; i += 1) {
          const res = yield* harness.send(
            feedbackRequest(
              encodeJson(
                makeFeedbackPayload({
                  id: `01990000-0000-7000-8000-${String(i).padStart(12, "0")}`,
                  userRequested: false,
                  trace: null,
                }),
              ),
            ),
          );
          expect(res.status).toBe(200);
        }
        const rateLimited = yield* harness.send(
          feedbackRequest(
            encodeJson(
              makeFeedbackPayload({
                id: "01990000-0000-7000-8000-000000000031",
                userRequested: false,
                trace: null,
              }),
            ),
          ),
        );
        expect(rateLimited.status).toBe(429);
        expect(Number(rateLimited.headers["retry-after"])).toBeGreaterThan(0);

        // Duplicate of an already-stored ID still returns 200 duplicate: true even at cap.
        const dupAtCap = yield* harness.send(feedbackRequest(encodeJson(payload)));
        expect(dupAtCap.status).toBe(200);
        expect(readJsonBody(dupAtCap)).toEqual({ ok: true, duplicate: true });

        // Another environment has its own quota.
        const otherEnv = yield* harness.send(
          feedbackRequest(
            encodeJson(
              makeFeedbackPayload({
                id: "01990000-0000-7000-8000-000000000032",
                userRequested: false,
                trace: null,
              }),
            ),
            { token: OTHER_TOKEN },
          ),
        );
        expect(otherEnv.status).toBe(200);

        // Request path never calls GitHub.
        expect(harness.githubCalls).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "processes pending GitHub issues in cron with privacy guarantees, stale sweep, lookback, and retry/unknown semantics",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-24T12:00:00.000Z"));

        // 1. Without token: sweeps stale claims (>15 min) to unknown, makes 0 GitHub calls.
        const noTokenHarness = yield* makeHarness({ githubToken: undefined });
        yield* noTokenHarness.send(feedbackRequest(encodeJson(makeFeedbackPayload())));
        yield* Effect.promise(() =>
          noTokenHarness.pg.query(
            `UPDATE agent_feedback SET github_issue_state = 'creating', github_issue_claimed_at = $1 WHERE id = $2`,
            ["2026-11-24T11:40:00.000Z", makeFeedbackPayload().id],
          ),
        );
        const noTokenResult = yield* noTokenHarness.service.processGithubIssues;
        expect(noTokenResult).toMatchObject({ staleMarkedUnknown: 1, claimed: 0 });
        expect(noTokenHarness.githubCalls).toHaveLength(0);

        // 2. With token: claims up to 5 recent pending rows (ignores >7 days old), creates issues cleanly.
        const harness = yield* makeHarness({
          githubToken: "ghp_test_token",
          createIssuesForAutoReports: true,
        });
        for (let i = 1; i <= 6; i += 1) {
          yield* harness.send(
            feedbackRequest(
              encodeJson(
                makeFeedbackPayload({
                  id: `fb-batch-${i}`,
                  userRequested: i !== 6,
                }),
              ),
            ),
          );
        }
        // Backdate fb-batch-1 past the 7-day lookback cutoff so only 2..6 (5 rows) qualify.
        yield* Effect.promise(() =>
          harness.pg.query(
            `UPDATE agent_feedback SET received_at = '2026-11-10T00:00:00.000Z' WHERE id = 'fb-batch-1'`,
          ),
        );

        const batchResult = yield* harness.service.processGithubIssues;
        expect(batchResult).toEqual({
          staleMarkedUnknown: 0,
          claimed: 5,
          created: 5,
          retried: 0,
          failed: 0,
          unknown: 0,
          aborted: false,
        });
        expect(harness.githubCalls).toHaveLength(5);
        for (const call of harness.githubCalls) {
          expect(call.request.url).toBe("https://api.github.com/repos/shuv1337/s2code/issues");
          expect(call.redirect).toBe("manual");
          expect(call.request.headers.authorization).toBe("Bearer ghp_test_token");
          expect(call.request.headers["x-github-api-version"]).toBe("2022-11-28");
          const bodyJson = JSON.stringify(call.body);
          expect(bodyJson).not.toContain("PRIVATE_CONVERSATION_CANARY");
          expect(bodyJson).not.toContain(SECRET_ENV_ID);
        }

        const states = yield* Effect.promise(() =>
          harness.pg.query<{
            readonly id: string;
            readonly github_issue_state: string;
            readonly github_issue_number: number | null;
          }>("SELECT id, github_issue_state, github_issue_number FROM agent_feedback ORDER BY id"),
        );
        expect(states.rows.find((r) => r.id === "fb-batch-1")?.github_issue_state).toBe("pending");
        expect(states.rows.find((r) => r.id === "fb-batch-2")).toMatchObject({
          github_issue_state: "created",
          github_issue_number: 1,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "handles GitHub 429 abort, 422 failed, 500 retry-to-failed, 504/transport unknown, and disallowed repo",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-24T12:00:00.000Z"));
        let nextResponse: (
          request: HttpClientRequest.HttpClientRequest,
        ) => Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError
        > = (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 429 })));

        const harness = yield* makeHarness({
          githubToken: "ghp_test_token",
          executeGithub: (request) => nextResponse(request),
        });

        // 429 aborts batch and releases remaining claimed rows back to pending without burning attempts.
        yield* harness.send(feedbackRequest(encodeJson(makeFeedbackPayload({ id: "fb-1" }))));
        yield* harness.send(feedbackRequest(encodeJson(makeFeedbackPayload({ id: "fb-2" }))));
        const rateLimitRun = yield* harness.service.processGithubIssues;
        expect(rateLimitRun).toMatchObject({ claimed: 2, retried: 1, aborted: true });
        expect(harness.githubCalls).toHaveLength(1);
        const afterAbort = yield* Effect.promise(() =>
          harness.pg.query<{
            readonly id: string;
            readonly github_issue_state: string;
            readonly github_issue_attempts: number;
          }>(
            "SELECT id, github_issue_state, github_issue_attempts FROM agent_feedback ORDER BY id",
          ),
        );
        expect(afterAbort.rows).toEqual([
          { id: "fb-1", github_issue_state: "pending", github_issue_attempts: 0 },
          { id: "fb-2", github_issue_state: "pending", github_issue_attempts: 0 },
        ]);

        // 422 marks failed immediately; 504 marks unknown immediately (no auto-retry).
        let callIndex = 0;
        nextResponse = (request) => {
          callIndex += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("", { status: callIndex === 1 ? 422 : 504 }),
            ),
          );
        };
        const mixedRun = yield* harness.service.processGithubIssues;
        expect(mixedRun).toMatchObject({ claimed: 2, failed: 1, unknown: 1, aborted: false });

        // 503 retries up to 5 attempts, then marks failed.
        yield* harness.send(feedbackRequest(encodeJson(makeFeedbackPayload({ id: "fb-retry" }))));
        nextResponse = (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 503 })));
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const res = yield* harness.service.processGithubIssues;
          expect(res).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
        }
        const fifth = yield* harness.service.processGithubIssues;
        expect(fifth).toMatchObject({ claimed: 1, retried: 0, failed: 1 });

        // Transport failure marks unknown.
        yield* harness.send(feedbackRequest(encodeJson(makeFeedbackPayload({ id: "fb-net" }))));
        nextResponse = (request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("socket closed"),
              }),
            }),
          );
        const netRun = yield* harness.service.processGithubIssues;
        expect(netRun).toMatchObject({ claimed: 1, unknown: 1 });

        // Disallowed repo at runtime aborts with 0 GitHub calls.
        const blockedHarness = yield* makeHarness({
          githubRepo: "pingdotgg/t3code",
          githubToken: "ghp_test_token",
        });
        yield* blockedHarness.send(
          feedbackRequest(encodeJson(makeFeedbackPayload({ id: "fb-bad" }))),
        );
        const blockedRun = yield* blockedHarness.service.processGithubIssues;
        expect(blockedRun).toMatchObject({ claimed: 0, aborted: true });
        expect(blockedHarness.githubCalls).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
