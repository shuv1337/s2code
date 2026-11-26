import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as McpToolExposure from "./McpToolExposure.ts";

it.effect("strictly caps compact dynamic bytes including JSON array commas", () =>
  Effect.gen(function* () {
    let announcements = 0;
    const exposure = McpToolExposure.make(
      () => [
        { name: "oversized_only", description: "Too large alone.", bytes: 3_501 },
        { name: "oversized_top", description: "Too large alpha.", bytes: 3_501 },
        { name: "small_alpha", description: "Fits alpha.", bytes: 500 },
        { name: "pair_a", description: "Boundary pair tool A.", bytes: 1_750 },
        { name: "pair_b", description: "Boundary pair tool B.", bytes: 1_750 },
      ],
      () =>
        Effect.sync(() => {
          announcements += 1;
        }),
    );

    // Oversized sole match is never force-admitted and triggers no list_changed.
    const soleOversized = yield* exposure.search("s-sole", "oversized_only", "compact");
    expect(soleOversized).toEqual([]);
    expect(exposure.isListed("s-sole", "oversized_only", "compact")).toBe(false);
    expect(announcements).toBe(0);

    // Oversized first match is skipped while a smaller matching tool still fits.
    const mixed = yield* exposure.search("s-mixed", "alpha", "compact");
    expect(mixed).toEqual([{ name: "small_alpha", description: "Fits alpha." }]);
    expect(exposure.isListed("s-mixed", "oversized_top", "compact")).toBe(false);
    expect(exposure.isListed("s-mixed", "small_alpha", "compact")).toBe(true);
    expect(announcements).toBe(1);

    // Exact raw sum 3,500 becomes 3,502 with +1 byte per JSON comma, so only one fits.
    const pair = yield* exposure.search("s-pair", "pair", "compact");
    expect(pair).toHaveLength(1);
    const listedPair = ["pair_a", "pair_b"].filter((name) =>
      exposure.isListed("s-pair", name, "compact"),
    );
    expect(listedPair).toHaveLength(1);
    expect(announcements).toBe(2);
  }),
);

it.effect("isolates loaded state by (session, mode) and keeps deferred direct searches quiet", () =>
  Effect.gen(function* () {
    let announcements = 0;
    const exposure = McpToolExposure.make(
      () => [
        { name: "delegate_task", description: "Delegates a task.", bytes: 500 },
        { name: "preview_open", description: "Opens a browser preview.", bytes: 500 },
      ],
      () =>
        Effect.sync(() => {
          announcements += 1;
        }),
    );

    // Deferred search for a direct tool returns it without mutating state or notifying.
    const direct = yield* exposure.search("shared-session", "delegate_task", "deferred");
    expect(direct).toEqual([{ name: "delegate_task", description: "Delegates a task." }]);
    expect(announcements).toBe(0);

    // Loading a deferred tool under deferred mode does not leak into compact for the same session.
    yield* exposure.search("shared-session", "browser", "deferred");
    expect(exposure.isListed("shared-session", "preview_open", "deferred")).toBe(true);
    expect(exposure.isListed("shared-session", "preview_open", "compact")).toBe(false);
    expect(announcements).toBe(1);

    // Headerless search (mode === undefined) returns matches without mutating state or notifying.
    const headerless = yield* exposure.search("headerless-session", "browser", undefined);
    expect(headerless).toEqual([{ name: "preview_open", description: "Opens a browser preview." }]);
    expect(exposure.isListed("headerless-session", "preview_open", "deferred")).toBe(false);
    expect(exposure.isListed("headerless-session", "preview_open", "compact")).toBe(false);
    expect(announcements).toBe(1);
  }),
);
