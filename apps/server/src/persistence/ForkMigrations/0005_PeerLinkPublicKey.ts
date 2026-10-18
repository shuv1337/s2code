import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Existing links must pair again; an unauthenticated probe cannot establish their pin.
  yield* sql`ALTER TABLE peer_environment_links ADD COLUMN peer_public_key TEXT`;
});
