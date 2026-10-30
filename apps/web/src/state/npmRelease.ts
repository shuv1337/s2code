import { useAtomValue } from "@effect/atom-react";
import { npmReleaseDatabaseMigration } from "@t3tools/shared/cliRelease";
import { NPM_PACKAGE_NAME } from "@t3tools/shared/productIdentity";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

export type ForkNpmPackage = "@s2code/cli" | "shuv2code";

export interface NpmRelease {
  readonly version: string;
  /** Absent on releases published before npm manifests carried it. */
  readonly databaseMigration: number | undefined;
}

const forkRegistryUrl = (packageName: string, spec: string) =>
  `https://registry.npmjs.org/${packageName.replace("/", "%2f")}/${encodeURIComponent(spec)}`;

const readNpmJson = (packageName: string, spec: string) =>
  HttpClient.get(forkRegistryUrl(packageName, spec)).pipe(
    Effect.flatMap((response) =>
      response.status === 404
        ? Effect.succeed(null)
        : HttpClientResponse.filterStatusOk(response).pipe(Effect.flatMap((ok) => ok.json)),
    ),
    Effect.orElseSucceed(() => null),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provide(FetchHttpClient.layer),
  );

// Older releases exist only under shuv2code. Prefer the new package when both
// publish, but retain the exact package that can install a requested version.
export const npmReleasePackageAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      for (const packageName of ["@s2code/cli", "shuv2code"] as const) {
        const body = yield* readNpmJson(packageName, version);
        if (
          typeof body === "object" &&
          body !== null &&
          "version" in body &&
          body.version === version
        )
          return packageName;
      }
      return null;
    }),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-package:${version}`),
  ),
);

/** `spec` is an exact version or a dist-tag such as `nightly`. Null when npm has no such release.
 * Looks up the fork package, never the upstream `t3` package. */
export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make(
    Effect.gen(function* () {
      const body = yield* HttpClient.get(forkRegistryUrl(NPM_PACKAGE_NAME, spec)).pipe(
        Effect.flatMap((response) => {
          if (response.status === 404) return Effect.succeed(null);
          return HttpClientResponse.filterStatusOk(response).pipe(Effect.flatMap((ok) => ok.json));
        }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.provide(FetchHttpClient.layer),
      );
      if (
        typeof body !== "object" ||
        body === null ||
        !("version" in body) ||
        typeof body.version !== "string"
      ) {
        return null;
      }
      return {
        version: body.version,
        databaseMigration: npmReleaseDatabaseMigration(body),
      } satisfies NpmRelease;
    }),
  ).pipe(Atom.withRefresh("5 minutes"), Atom.withLabel(`npm-release:${spec}`)),
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
