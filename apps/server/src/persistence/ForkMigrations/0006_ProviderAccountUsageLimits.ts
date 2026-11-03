import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE provider_account_usage_limits (
      account TEXT PRIMARY KEY,
      driver TEXT NOT NULL,
      spent INTEGER NOT NULL,
      changed_at TEXT NOT NULL,
      origin_environment_id TEXT NOT NULL,
      origin_label TEXT NOT NULL,
      message TEXT,
      applied INTEGER NOT NULL,
      checked TEXT NOT NULL DEFAULT '{}'
    )
  `;
});
