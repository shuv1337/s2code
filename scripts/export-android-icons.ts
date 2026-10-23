#!/usr/bin/env node
// Android supplies the outer mask. Keep the approved terminal inside its safe zone.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

class AndroidIconRenderError extends Schema.TaggedError<AndroidIconRenderError>()(
  "AndroidIconRenderError",
  { cause: Schema.Defect() },
) {}

const exportAndroidIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const master = yield* fs.readFileString(
    path.join(root, "assets/brand/s2code-devil-terminal.svg"),
  );
  const mono = yield* fs.readFileString(
    path.join(root, "assets/brand/s2code-devil-terminal-monochrome.svg"),
  );
  const render = (svg: string, size: number, background?: string) =>
    Effect.tryPromise({
      try: () =>
        sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${background ? `<rect width="512" height="512" fill="${background}"/>` : ""}<g transform="translate(256 256) scale(.6) translate(-256 -256)">${svg}</g></svg>`,
          ),
        )
          .png()
          .toBuffer(),
      catch: (cause) => new AndroidIconRenderError({ cause }),
    });
  const write = (name: string, contents: Uint8Array) =>
    fs.writeFile(path.join(root, "apps/mobile/assets", name), contents);
  for (const [variant, color] of [
    ["prod", "#D35C46"],
    ["dev", "#176BFF"],
    ["nightly", "#7656E8"],
  ] as const) {
    const svg = master.replaceAll("#D35C46", color);
    yield* write(
      `android-icon-foreground${variant === "prod" ? "" : `-${variant}`}.png`,
      yield* render(svg, 432),
    );
    yield* write(`android-splash-icon-${variant}.png`, yield* render(svg, 1152, "#0C1119"));
    if (variant !== "prod") {
      const background = yield* Effect.tryPromise({
        try: () =>
          sharp({ create: { width: 432, height: 432, channels: 4, background: "#0C1119" } })
            .png()
            .toBuffer(),
        catch: (cause) => new AndroidIconRenderError({ cause }),
      });
      yield* write(`android-icon-background-${variant}.png`, background);
    }
  }
  yield* write(
    "android-icon-mark.png",
    yield* render(mono.replaceAll("currentColor", "#FFFFFF"), 432),
  );
  yield* write(
    "android-notification-icon.png",
    yield* render(mono.replaceAll("currentColor", "#FFFFFF"), 96),
  );
  yield* Console.log("Exported S2Code Android icons from the approved SVG masters.");
});

if (import.meta.main)
  exportAndroidIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
