import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

export type ForkNpmPackage = "s2code" | "shuv2code";

// Older releases exist only under shuv2code. Prefer the new package when both
// publish, but retain the exact package that can install a requested version.
export const npmReleasePackageAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      for (const packageName of ["s2code", "shuv2code"] as const) {
        const body = yield* HttpClient.get(
          `https://registry.npmjs.org/${packageName}/${encodeURIComponent(version)}`,
        ).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((ok) => ok.json),
          Effect.orElseSucceed(() => null),
        );
        if (
          typeof body === "object" &&
          body !== null &&
          "version" in body &&
          body.version === version
        )
          return packageName;
      }
      return null;
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight, which npm rejects.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-package:${version}`),
  ),
);

export const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make((get) => AsyncResult.map(get(npmReleasePackageAtom(version)), (name) => name !== null)),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success<ForkNpmPackage | null>(null)).pipe(
  Atom.withLabel("npm-release-package:none"),
);

export function useNpmReleasePackage(version: string | null): ForkNpmPackage | null {
  const result = useAtomValue(version ? npmReleasePackageAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => null);
}

export function useNpmReleasePublished(version: string | null): boolean {
  return useNpmReleasePackage(version) !== null;
}
