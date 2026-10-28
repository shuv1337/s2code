import * as Effect from "effect/Effect";

// Upstream migration 71 now owns this schema and always runs first. Kept so
// fork ledgers that recorded this id still match the manifest.
export default Effect.void;
