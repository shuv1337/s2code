import { describe, expect, it } from "@effect/vitest";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "./update-manifest.ts";

// Shape electron-builder writes for a Linux AppImage feed.
const linuxFeed = `version: 0.0.46-nightly.20261016.37
files:
  - url: S2Code-0.0.46-nightly.20261016.37-x86_64.AppImage
    sha512: abc123==
    size: 130000000
    blockMapSize: 211644
path: S2Code-0.0.46-nightly.20261016.37-x86_64.AppImage
sha512: abc123==
releaseDate: '2026-10-16T23:59:00.000Z'
`;

describe("update manifests", () => {
  it("keeps an AppImage blockMapSize through parse and serialize", () => {
    const manifest = parseUpdateManifest(linuxFeed, "nightly-linux.yml", "linux");
    expect(manifest.files).toEqual([
      {
        url: "S2Code-0.0.46-nightly.20261016.37-x86_64.AppImage",
        sha512: "abc123==",
        size: 130000000,
        blockMapSize: 211644,
      },
    ]);
    const roundTripped = parseUpdateManifest(
      serializeUpdateManifest(manifest, { platformLabel: "linux" }),
      "roundtrip.yml",
      "linux",
    );
    expect(roundTripped).toEqual(manifest);
  });

  it("rejects merging entries that disagree on blockMapSize", () => {
    const manifest = parseUpdateManifest(linuxFeed, "a.yml", "linux");
    const changed = parseUpdateManifest(
      linuxFeed.replace("blockMapSize: 211644", "blockMapSize: 1"),
      "b.yml",
      "linux",
    );
    expect(() => mergeUpdateManifests(manifest, changed, "linux")).toThrow(
      "conflicting file entry",
    );
  });
});
