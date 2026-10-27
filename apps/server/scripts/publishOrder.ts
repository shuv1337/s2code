import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

/**
 * The launcher must never be installable before its executables. A failed platform does not
 * interrupt the others (npm never accepts a version twice, and an interrupted upload may be
 * live); the launcher is then skipped and the first failure returned.
 */
export const publishPlatformsThenLauncher = Effect.fn("publishPlatformsThenLauncher")(function* <
  E,
  R,
>(input: {
  readonly platformTarballs: ReadonlyArray<string>;
  readonly launcherTarball: string;
  readonly publish: (tarball: string) => Effect.Effect<void, E, R>;
}) {
  const results = yield* Effect.all(input.platformTarballs.map(input.publish), {
    concurrency: "unbounded",
    mode: "result",
  });
  const failed = results.find(Result.isFailure);
  if (failed) {
    return yield* Effect.fail(failed.failure);
  }
  yield* input.publish(input.launcherTarball);
});
