import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { browserSetupHomeForUser } from "./browser.ts";

it.effect.each(["stable", "nightly", "preview"])(
  "selects the invoking user's %s home for sudo browser setup",
  (channel) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const version = channel === "stable" ? "1.2.3" : `1.2.3-${channel}.20261014.1`;
      expect(browserSetupHomeForUser(path, "/home/invoking-user", version)).toBe(
        path.join(
          "/home/invoking-user",
          `.shuv2code-v2${channel === "stable" ? "" : `-${channel}`}`,
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
