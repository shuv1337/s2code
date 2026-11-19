import { useAtomValue } from "@effect/atom-react";
import { NPM_PACKAGE_NAME } from "@t3tools/shared/productIdentity";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

export type ForkNpmPackage = "@s2code/cli" | "shuv2code";

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

// Every fork release is published as shuv2code; @s2code/cli only ever mirrored some of them.
export const npmReleasePackageAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const body = yield* readNpmJson(NPM_PACKAGE_NAME, version);
      return typeof body === "object" &&
        body !== null &&
        "version" in body &&
        body.version === version
        ? NPM_PACKAGE_NAME
        : null;
    }),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-package:${version}`),
  ),
);

export const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make((get) => AsyncResult.map(get(npmReleasePackageAtom(version)), (name) => name !== null)),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success<typeof NPM_PACKAGE_NAME | null>(null)).pipe(
  Atom.withLabel("npm-release-package:none"),
);

export function useNpmReleasePackage(version: string | null): ForkNpmPackage | null {
  const result = useAtomValue(version ? npmReleasePackageAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => null);
}

export function useNpmReleasePublished(version: string | null): boolean {
  return useNpmReleasePackage(version) !== null;
}
