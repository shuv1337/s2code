import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { PRODUCT_ID, productNpmVersionUrl } from "@t3tools/shared/productIdentity";

/**
 * Whether the fork package is published on npm. A 404 is false; network and
 * registry errors stay unknown. Both re-check every few minutes, so a release
 * that lands later shows up without a reload.
 */
export const checkNpmReleasePublished = Effect.fnUntraced(function* (version: string) {
  const response = yield* HttpClient.get(productNpmVersionUrl(version));
  if (response.status === 404) return false;
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap((ok) => ok.json),
  );
  return typeof body === "object" && body !== null && "version" in body && "name" in body
    ? body.name === PRODUCT_ID && body.version === version
    : false;
});

const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(checkNpmReleasePublished(version).pipe(Effect.provide(FetchHttpClient.layer))).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("npm-release-published:none"),
);

/** True only once npm confirms the version, so callers can hide work that
    would download it until then. */
export function useNpmReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? npmReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
