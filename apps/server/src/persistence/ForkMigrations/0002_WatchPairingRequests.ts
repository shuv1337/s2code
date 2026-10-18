import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE auth_watch_pairing_requests (
      device_code_hash TEXT PRIMARY KEY,
      user_code TEXT NOT NULL,
      client_label TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
      credential TEXT,
      credential_expires_at TEXT,
      restriction_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_polled_at TEXT,
      poll_interval_seconds INTEGER NOT NULL DEFAULT 5
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_auth_watch_pairing_requests_pending_user_code
    ON auth_watch_pairing_requests (user_code)
    WHERE status = 'pending'
  `;
});
