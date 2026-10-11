import { ThreadId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export interface WatchRestriction {
  readonly threadIds?: ReadonlyArray<ThreadId>;
  readonly projectIds?: ReadonlyArray<ProjectId>;
}

export const WatchCursor = Schema.Struct({
  pinned: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }), Schema.isInt()),
  updatedAt: Schema.String,
  threadId: ThreadId,
});
export type WatchCursor = typeof WatchCursor.Type;
export interface WatchThreadQuery {
  readonly cursor?: WatchCursor | undefined;
  readonly limit: number;
  readonly restriction?: WatchRestriction | undefined;
}

const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
/** Keyset pagination bounds materialized rows before loading any thread shell. */
export const listWatchThreadIds = Effect.fn("watch.listThreadIds")(function* (
  input: WatchThreadQuery,
) {
  const sql = yield* SqlClient.SqlClient;
  const restriction = input.restriction;
  const threadIds = yield* encodeIds(restriction?.threadIds ?? []);
  const projectIds = yield* encodeIds(restriction?.projectIds ?? []);
  return yield* sql<{ threadId: ThreadId; pinned: number; updatedAt: string }>`
      SELECT thread_id AS "threadId", updated_at AS "updatedAt",
        (json_extract(payload_json, '$.pinnedAt') IS NOT NULL) AS pinned
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.archivedAt') IS NULL
        ${restriction?.threadIds === undefined ? sql`` : sql`AND thread_id IN (SELECT value FROM json_each(${threadIds}))`}
        ${restriction?.projectIds === undefined ? sql`` : sql`AND project_id IN (SELECT value FROM json_each(${projectIds}))`}
        ${
          input.cursor === undefined
            ? sql``
            : sql`AND (
          (json_extract(payload_json, '$.pinnedAt') IS NOT NULL), updated_at, thread_id
        ) < (${input.cursor.pinned}, ${input.cursor.updatedAt}, ${input.cursor.threadId})`
        }
      ORDER BY pinned DESC, updated_at DESC, thread_id DESC
      LIMIT ${Math.min(51, Math.max(1, input.limit))}
    `;
});
