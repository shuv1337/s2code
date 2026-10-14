import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { checkNpmReleasePublished } from "./npmRelease";

it.effect.each([
  { status: 200, body: { name: "shuv2code", version: "1.2.3" }, published: true },
  { status: 200, body: { name: "t3", version: "1.2.3" }, published: false },
  { status: 200, body: { name: "shuv2code", version: "9.9.9" }, published: false },
  { status: 404, body: {}, published: false },
] as const)("checks only the fork registry entry and identity: %j", ({ status, body, published }) =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const client = HttpClient.make((request) => {
      urls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
      );
    });
    expect(
      yield* checkNpmReleasePublished("1.2.3").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
    ).toBe(published);
    expect(urls).toEqual(["https://registry.npmjs.org/shuv2code/1.2.3"]);
  }),
);
