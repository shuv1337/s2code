import type { AgentFeedbackKind, AgentFeedbackTrace, ClientOs } from "@t3tools/contracts";
import {
  RELAY_AGENT_FEEDBACK_MAX_TRACE_ENTRIES,
  RelayAgentFeedbackRequest,
  RelayApi,
  RelayEnvironmentPrincipal,
  type RelayAgentFeedbackSource,
} from "@t3tools/contracts/relay";
import { and, asc, eq, gte, isNull, lt, or, sql as drizzleSql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as RelayDb from "../db.ts";
import { assertForkFeedbackGithubRepo } from "../forkOwnership.ts";
import {
  agentFeedback,
  type AgentFeedbackGithubIssueState,
} from "../persistence/feedbackSchema.ts";

export const AGENT_FEEDBACK_MAX_BODY_BYTES = 64 * 1024;
export const AGENT_FEEDBACK_MAX_PER_ENVIRONMENT_PER_HOUR = 30;
export const AGENT_FEEDBACK_GITHUB_BATCH_SIZE = 5;
export const AGENT_FEEDBACK_GITHUB_MAX_ATTEMPTS = 5;
export const AGENT_FEEDBACK_GITHUB_LOOKBACK_DAYS = 7;
export const AGENT_FEEDBACK_GITHUB_STALE_CLAIM_MINUTES = 15;
export const AGENT_FEEDBACK_GITHUB_LABEL = "agent-feedback";
const AGENT_FEEDBACK_GITHUB_TIMEOUT = Duration.seconds(10);

const decodeFeedbackRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentFeedbackRequest),
);

const GithubIssueCreatedResponse = Schema.fromJsonString(
  Schema.Struct({
    number: Schema.Int,
    html_url: Schema.String,
  }),
);
const decodeGithubIssueCreated = Schema.decodeUnknownOption(GithubIssueCreatedResponse);

export class AgentFeedbackSettings extends Context.Service<
  AgentFeedbackSettings,
  {
    readonly githubRepo: string;
    readonly githubToken: Redacted.Redacted<string> | undefined;
    readonly createIssuesForAutoReports: boolean;
  }
>()("t3code-relay/feedback/AgentFeedback/AgentFeedbackSettings") {}

export interface ProcessGithubIssuesResult {
  readonly staleMarkedUnknown: number;
  readonly claimed: number;
  readonly created: number;
  readonly retried: number;
  readonly failed: number;
  readonly unknown: number;
  readonly aborted: boolean;
}

export class AgentFeedbackPersistenceError extends Schema.TaggedError<AgentFeedbackPersistenceError>()(
  "AgentFeedbackPersistenceError",
  { cause: Schema.Defect() },
) {}

export class AgentFeedback extends Context.Service<
  AgentFeedback,
  {
    readonly handle: (
      request: HttpServerRequest.HttpServerRequest,
      environmentId: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly processGithubIssues: Effect.Effect<
      ProcessGithubIssuesResult,
      AgentFeedbackPersistenceError
    >;
  }
>()("t3code-relay/feedback/AgentFeedback") {}

class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("BodyTooLarge", {}) {}

const errorResponse = (status: number, error: string, headers?: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, ...(headers ? { headers } : {}) });

const readCapped = <E>(stream: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  Effect.suspend(() => {
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    return stream.pipe(
      Stream.runForEach((chunk) => {
        total += chunk.length;
        if (total > maxBytes) return Effect.fail(new BodyTooLarge());
        chunks.push(chunk);
        return Effect.void;
      }),
      Effect.map(() => {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.length;
        }
        return body;
      }),
    );
  });

const hasNoBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.source instanceof Request && request.source.body === null;

function parseContentLength(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function fencedBlock(content: string): string {
  const normalized = content.replace(/\r\n/gu, "\n");
  let longest = 0;
  for (const match of normalized.matchAll(/`+/gu)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${normalized}\n${fence}`;
}

export interface FeedbackIssueRecord {
  readonly id: string;
  readonly receivedAt: string;
  readonly createdAt: string;
  readonly kind: typeof AgentFeedbackKind.Type;
  readonly subject: string;
  readonly expected: string;
  readonly actual: string;
  readonly workaround: string;
  readonly userRequested: boolean;
  readonly source: RelayAgentFeedbackSource;
  readonly traceJson: AgentFeedbackTrace | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly serverVersion: string | null;
  readonly telemetryChannel: string | null;
  readonly serverOs: ClientOs | null;
  readonly serverArch: string | null;
  readonly serverMode: string | null;
}

export interface FormattedGithubIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
}

function formatTraceOutlineEntry(entry: AgentFeedbackTrace["entries"][number]): string {
  const parts: Array<string> = [`turn ${entry.turn}`, entry.type];
  if (entry.tool !== undefined) parts.push(entry.tool);
  if (entry.outcome !== undefined) parts.push(entry.outcome);
  if (entry.durationMs !== undefined) parts.push(`${entry.durationMs}ms`);
  if (entry.length !== undefined) parts.push(`${entry.length} chars`);
  return parts.join(" · ");
}

/**
 * Formats a public GitHub issue payload without environment IDs, user IDs, IPs,
 * or conversation turn text (only the structural trace outline is included).
 */
export function formatFeedbackGithubIssue(record: FeedbackIssueRecord): FormattedGithubIssue {
  const safeSubject = record.subject.replace(/[\r\n]+/gu, " ").trim();
  const title = `Agent feedback: ${record.kind} · ${safeSubject}`;
  const metadata: Array<string> = [
    `- **Kind:** \`${record.kind}\``,
    `- **Subject:** \`${safeSubject}\``,
    `- **Source:** \`${record.source}\``,
    `- **User requested:** ${record.userRequested ? "yes" : "no"}`,
  ];
  if (record.provider) metadata.push(`- **Provider:** \`${record.provider}\``);
  if (record.model) metadata.push(`- **Model:** \`${record.model}\``);
  if (record.serverVersion) metadata.push(`- **Server version:** \`${record.serverVersion}\``);
  if (record.telemetryChannel) metadata.push(`- **Channel:** \`${record.telemetryChannel}\``);
  if (record.serverOs) metadata.push(`- **OS:** \`${record.serverOs}\``);
  if (record.serverArch) metadata.push(`- **Arch:** \`${record.serverArch}\``);
  if (record.serverMode) metadata.push(`- **Mode:** \`${record.serverMode}\``);
  metadata.push(`- **Received:** \`${record.receivedAt}\``);

  const sections: Array<string> = [
    `<!-- s2code-feedback-id: ${record.id} -->`,
    metadata.join("\n"),
    `### Expected\n\n${fencedBlock(record.expected)}`,
    `### Actual\n\n${fencedBlock(record.actual)}`,
  ];
  if (record.workaround.trim().length > 0) {
    sections.push(`### Workaround\n\n${fencedBlock(record.workaround)}`);
  }
  if (record.traceJson !== null) {
    const trace = record.traceJson;
    const summarySuffix = trace.truncated ? ", truncated" : "";
    const outlineLines = trace.entries.map(formatTraceOutlineEntry).join("\n");
    sections.push(
      [
        `<details>`,
        `<summary>Trace outline (${trace.turns} turns, ${trace.entries.length} entries${summarySuffix})</summary>`,
        "",
        fencedBlock(outlineLines),
        "",
        `</details>`,
      ].join("\n"),
    );
  }
  return {
    title,
    body: sections.join("\n\n"),
    labels: [AGENT_FEEDBACK_GITHUB_LABEL],
  };
}

interface ClaimedFeedbackRow extends FeedbackIssueRecord {
  readonly githubIssueAttempts: number;
}

interface RawClaimedRow {
  readonly id: string;
  readonly received_at: string;
  readonly created_at: string;
  readonly kind: typeof AgentFeedbackKind.Type;
  readonly subject: string;
  readonly expected: string;
  readonly actual: string;
  readonly workaround: string;
  readonly user_requested: boolean;
  readonly source: RelayAgentFeedbackSource;
  readonly trace_json: AgentFeedbackTrace | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly server_version: string | null;
  readonly telemetry_channel: string | null;
  readonly server_os: ClientOs | null;
  readonly server_arch: string | null;
  readonly server_mode: string | null;
  readonly github_issue_attempts: number;
}

function extractRows<T>(result: unknown): ReadonlyArray<T> {
  if (Array.isArray(result)) return result as ReadonlyArray<T>;
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray((result as { readonly rows: unknown }).rows)
  ) {
    return (result as { readonly rows: ReadonlyArray<T> }).rows;
  }
  return [];
}

function mapClaimedRow(row: RawClaimedRow): ClaimedFeedbackRow {
  return {
    id: row.id,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    kind: row.kind,
    subject: row.subject,
    expected: row.expected,
    actual: row.actual,
    workaround: row.workaround,
    userRequested: Boolean(row.user_requested),
    source: row.source,
    traceJson: row.trace_json ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    serverVersion: row.server_version ?? null,
    telemetryChannel: row.telemetry_channel ?? null,
    serverOs: row.server_os ?? null,
    serverArch: row.server_arch ?? null,
    serverMode: row.server_mode ?? null,
    githubIssueAttempts: Number(row.github_issue_attempts),
  };
}

function isAbortBatchStatus(status: number, headers: Readonly<Record<string, string>>): boolean {
  if (status >= 300 && status < 400) return true;
  if (status === 401 || status === 403 || status === 404 || status === 410 || status === 429) {
    return true;
  }
  return headers["x-ratelimit-remaining"] === "0";
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const settings = yield* AgentFeedbackSettings;
  const httpClient = yield* HttpClient.HttpClient;

  const handle = Effect.fn("relay.feedback.ingest")(function* (
    request: HttpServerRequest.HttpServerRequest,
    environmentId: string,
  ) {
    const contentLength = parseContentLength(request.headers["content-length"]);
    if (contentLength !== undefined && contentLength > AGENT_FEEDBACK_MAX_BODY_BYTES) {
      return errorResponse(413, "body_too_large");
    }

    const bodyResult = yield* (
      hasNoBody(request)
        ? Effect.succeed(new Uint8Array(0))
        : readCapped(request.stream, AGENT_FEEDBACK_MAX_BODY_BYTES)
    ).pipe(Effect.result);
    if (Result.isFailure(bodyResult)) {
      const tooLarge = bodyResult.failure._tag === "BodyTooLarge";
      return errorResponse(tooLarge ? 413 : 400, tooLarge ? "body_too_large" : "invalid_body");
    }

    const decoded = decodeFeedbackRequest(new TextDecoder().decode(bodyResult.success));
    if (Option.isNone(decoded)) {
      return errorResponse(400, "invalid_payload");
    }
    const payload = decoded.value;
    if (
      payload.trace !== null &&
      payload.trace.entries.length > RELAY_AGENT_FEEDBACK_MAX_TRACE_ENTRIES
    ) {
      return errorResponse(400, "invalid_payload");
    }

    const persisted = yield* Effect.gen(function* () {
      const existing = yield* db
        .select({ id: agentFeedback.id })
        .from(agentFeedback)
        .where(
          and(eq(agentFeedback.id, payload.id), eq(agentFeedback.environmentId, environmentId)),
        )
        .limit(1);
      if (existing.length > 0) {
        return { kind: "ok" as const, duplicate: true };
      }

      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const windowStartIso = DateTime.formatIso(DateTime.subtract(now, { hours: 1 }));
      const recent = yield* db
        .select({ receivedAt: agentFeedback.receivedAt })
        .from(agentFeedback)
        .where(
          and(
            eq(agentFeedback.environmentId, environmentId),
            gte(agentFeedback.receivedAt, windowStartIso),
          ),
        )
        .orderBy(asc(agentFeedback.receivedAt))
        .limit(AGENT_FEEDBACK_MAX_PER_ENVIRONMENT_PER_HOUR);
      if (recent.length >= AGENT_FEEDBACK_MAX_PER_ENVIRONMENT_PER_HOUR) {
        const oldest = recent[0]?.receivedAt;
        const oldestMs = oldest ? Date.parse(oldest) : Number.NaN;
        const nowMs = DateTime.toEpochMillis(now);
        const retryAfterSeconds = Number.isFinite(oldestMs)
          ? Math.max(1, Math.ceil((oldestMs + 3_600_000 - nowMs) / 1_000))
          : 3_600;
        return { kind: "rate_limited" as const, retryAfterSeconds };
      }

      const githubIssueState: AgentFeedbackGithubIssueState =
        payload.userRequested || settings.createIssuesForAutoReports ? "pending" : "none";
      const inserted = yield* db
        .insert(agentFeedback)
        .values({
          id: payload.id,
          environmentId,
          receivedAt: nowIso,
          createdAt: payload.createdAt,
          kind: payload.kind,
          subject: payload.subject,
          expected: payload.expected,
          actual: payload.actual,
          workaround: payload.workaround,
          userRequested: payload.userRequested,
          source: payload.source,
          traceJson: payload.trace,
          provider: payload.provider ?? null,
          model: payload.model ?? null,
          serverVersion: payload.serverVersion ?? null,
          telemetryChannel: payload.telemetryChannel ?? null,
          serverOs: payload.serverOs ?? null,
          serverArch: payload.serverArch ?? null,
          serverMode: payload.serverMode ?? null,
          githubIssueState,
          githubIssueAttempts: 0,
        })
        .onConflictDoNothing({ target: agentFeedback.id })
        .returning({ id: agentFeedback.id });

      return { kind: "ok" as const, duplicate: inserted.length === 0 };
    }).pipe(Effect.result);

    if (Result.isFailure(persisted)) {
      yield* Effect.logWarning("Failed to store agent feedback report", {
        reportId: payload.id,
        error: String(persisted.failure),
      });
      return errorResponse(500, "persistence_failed");
    }

    if (persisted.success.kind === "rate_limited") {
      return errorResponse(429, "rate_limited", {
        "retry-after": String(persisted.success.retryAfterSeconds),
      });
    }

    return HttpServerResponse.jsonUnsafe(
      { ok: true as const, duplicate: persisted.success.duplicate },
      { status: 200 },
    );
  });

  const postGithubIssue = Effect.fn("relay.feedback.postGithubIssue")(function* (
    repo: string,
    token: string,
    issue: FormattedGithubIssue,
  ) {
    const request = yield* HttpClientRequest.post(`https://api.github.com/repos/${repo}/issues`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "s2code-relay",
        authorization: `Bearer ${token}`,
      },
    }).pipe(HttpClientRequest.bodyJson(issue));

    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeoutOption(AGENT_FEEDBACK_GITHUB_TIMEOUT),
      );
    if (Option.isNone(response)) {
      return { kind: "timeout" as const };
    }
    const text = yield* response.value.text.pipe(Effect.orElseSucceed(() => ""));
    return {
      kind: "response" as const,
      status: response.value.status,
      headers: response.value.headers,
      text,
    };
  });

  const releaseClaimedPending = (row: ClaimedFeedbackRow, error: string | null) =>
    db
      .update(agentFeedback)
      .set({
        githubIssueState: "pending",
        githubIssueAttempts: Math.max(0, row.githubIssueAttempts - 1),
        githubIssueClaimedAt: null,
        githubIssueError: error,
      })
      .where(and(eq(agentFeedback.id, row.id), eq(agentFeedback.githubIssueState, "creating")));

  const runProcessGithubIssues = Effect.fn("relay.feedback.processGithubIssues")(function* () {
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    const staleBeforeIso = DateTime.formatIso(
      DateTime.subtract(now, { minutes: AGENT_FEEDBACK_GITHUB_STALE_CLAIM_MINUTES }),
    );
    const stale = yield* db
      .update(agentFeedback)
      .set({
        githubIssueState: "unknown",
        githubIssueError: "stale_claim_timeout",
      })
      .where(
        and(
          eq(agentFeedback.githubIssueState, "creating"),
          or(
            isNull(agentFeedback.githubIssueClaimedAt),
            lt(agentFeedback.githubIssueClaimedAt, staleBeforeIso),
          ),
        ),
      )
      .returning({ id: agentFeedback.id });

    const rawToken = settings.githubToken ? Redacted.value(settings.githubToken).trim() : "";
    if (!rawToken) {
      return {
        staleMarkedUnknown: stale.length,
        claimed: 0,
        created: 0,
        retried: 0,
        failed: 0,
        unknown: 0,
        aborted: false,
      };
    }

    const validatedRepo = yield* Effect.try({
      try: () => assertForkFeedbackGithubRepo(settings.githubRepo),
      catch: (error) => (error instanceof Error ? error.message : "Invalid FEEDBACK_GITHUB_REPO."),
    }).pipe(Effect.result);
    if (Result.isFailure(validatedRepo)) {
      yield* Effect.logError("Refusing to create feedback GitHub issues for disallowed repo", {
        reason: validatedRepo.failure,
      });
      return {
        staleMarkedUnknown: stale.length,
        claimed: 0,
        created: 0,
        retried: 0,
        failed: 0,
        unknown: 0,
        aborted: true,
      };
    }
    const repo = validatedRepo.success;

    const lookbackCutoffIso = DateTime.formatIso(
      DateTime.subtract(now, { days: AGENT_FEEDBACK_GITHUB_LOOKBACK_DAYS }),
    );
    const claimResult = yield* db.execute(drizzleSql`
      UPDATE "agent_feedback"
      SET
        "github_issue_state" = 'creating',
        "github_issue_attempts" = "github_issue_attempts" + 1,
        "github_issue_claimed_at" = ${nowIso},
        "github_issue_error" = NULL
      WHERE "id" IN (
        SELECT "id"
        FROM "agent_feedback"
        WHERE "github_issue_state" = 'pending'
          AND "received_at" >= ${lookbackCutoffIso}
        ORDER BY "received_at" ASC, "id" ASC
        LIMIT ${AGENT_FEEDBACK_GITHUB_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        "id",
        "received_at",
        "created_at",
        "kind",
        "subject",
        "expected",
        "actual",
        "workaround",
        "user_requested",
        "source",
        "trace_json",
        "provider",
        "model",
        "server_version",
        "telemetry_channel",
        "server_os",
        "server_arch",
        "server_mode",
        "github_issue_attempts"
    `);
    const claimed = extractRows<RawClaimedRow>(claimResult).map(mapClaimedRow);

    let created = 0;
    let retried = 0;
    let failed = 0;
    let unknown = 0;
    let aborted = false;

    for (let index = 0; index < claimed.length; index += 1) {
      const row = claimed[index]!;
      const issue = formatFeedbackGithubIssue(row);
      const outcome = yield* postGithubIssue(repo, rawToken, issue).pipe(Effect.result);

      if (Result.isFailure(outcome)) {
        yield* db
          .update(agentFeedback)
          .set({
            githubIssueState: "unknown",
            githubIssueError: "github_transport_error",
          })
          .where(eq(agentFeedback.id, row.id));
        unknown += 1;
        continue;
      }

      if (outcome.success.kind === "timeout") {
        yield* db
          .update(agentFeedback)
          .set({
            githubIssueState: "unknown",
            githubIssueError: "github_request_timeout",
          })
          .where(eq(agentFeedback.id, row.id));
        unknown += 1;
        continue;
      }

      const { status, headers, text } = outcome.success;
      if (status === 201) {
        const parsed = decodeGithubIssueCreated(text);
        if (Option.isSome(parsed)) {
          yield* db
            .update(agentFeedback)
            .set({
              githubIssueState: "created",
              githubIssueNumber: parsed.value.number,
              githubIssueUrl: parsed.value.html_url,
              githubIssueError: null,
            })
            .where(eq(agentFeedback.id, row.id));
          created += 1;
        } else {
          yield* db
            .update(agentFeedback)
            .set({
              githubIssueState: "unknown",
              githubIssueError: "github_invalid_201_body",
            })
            .where(eq(agentFeedback.id, row.id));
          unknown += 1;
        }
        continue;
      }

      if (isAbortBatchStatus(status, headers)) {
        const reason =
          status === 429 || headers["x-ratelimit-remaining"] === "0"
            ? "github_rate_limited"
            : `github_http_${status}`;
        yield* releaseClaimedPending(row, reason);
        retried += 1;
        aborted = true;
        // Release remaining claimed rows without consuming attempts so the next cron picks them up.
        for (let rest = index + 1; rest < claimed.length; rest += 1) {
          yield* releaseClaimedPending(claimed[rest]!, null);
        }
        break;
      }

      if (status === 422) {
        yield* db
          .update(agentFeedback)
          .set({
            githubIssueState: "failed",
            githubIssueError: "github_http_422",
          })
          .where(eq(agentFeedback.id, row.id));
        failed += 1;
        continue;
      }

      if (status === 502 || status === 504) {
        yield* db
          .update(agentFeedback)
          .set({
            githubIssueState: "unknown",
            githubIssueError: `github_http_${status}`,
          })
          .where(eq(agentFeedback.id, row.id));
        unknown += 1;
        continue;
      }

      if (status === 500 || status === 503) {
        if (row.githubIssueAttempts >= AGENT_FEEDBACK_GITHUB_MAX_ATTEMPTS) {
          yield* db
            .update(agentFeedback)
            .set({
              githubIssueState: "failed",
              githubIssueError: `github_http_${status}`,
            })
            .where(eq(agentFeedback.id, row.id));
          failed += 1;
        } else {
          yield* db
            .update(agentFeedback)
            .set({
              githubIssueState: "pending",
              githubIssueClaimedAt: null,
              githubIssueError: `github_http_${status}`,
            })
            .where(eq(agentFeedback.id, row.id));
          retried += 1;
        }
        continue;
      }

      yield* db
        .update(agentFeedback)
        .set({
          githubIssueState: status >= 200 && status < 300 ? "unknown" : "failed",
          githubIssueError: `github_http_${status}`,
        })
        .where(eq(agentFeedback.id, row.id));
      if (status >= 200 && status < 300) unknown += 1;
      else failed += 1;
    }

    return {
      staleMarkedUnknown: stale.length,
      claimed: claimed.length,
      created,
      retried,
      failed,
      unknown,
      aborted,
    };
  });

  const processGithubIssues: AgentFeedback["Service"]["processGithubIssues"] = Effect.suspend(() =>
    runProcessGithubIssues().pipe(
      Effect.mapError((cause) => new AgentFeedbackPersistenceError({ cause })),
    ),
  );

  return AgentFeedback.of({ handle, processGithubIssues });
});

export const layer = Layer.effect(AgentFeedback, make);

/** Raw so the request body is capped before JSON decoding. */
export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "feedback",
  Effect.fnUntraced(function* (handlers) {
    const feedback = yield* AgentFeedback;
    return handlers.handleRaw("submitAgentFeedback", ({ request }) =>
      Effect.flatMap(RelayEnvironmentPrincipal, ({ environmentId }) =>
        feedback.handle(request, environmentId),
      ),
    );
  }),
);
