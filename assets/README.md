# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses `text.svg` for the T3 mark and `background.svg` when the background is a vector layer. Additional layers use semantic names that describe their role and placement.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer 2 or newer on macOS. The script selects the newest compatible exporter from Xcode or a standalone Icon Composer installation and pins design generation 26. Set `ICON_COMPOSER_TOOL` to the full path of `Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

The tracked macOS PNGs are flat SVG renders rather than Icon Composer exports. Render each variant's raw mark with `rsvg-convert` at 1024×1024 using this wrapper, substituting the variant colour and mark paths:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="100" y="100" width="824" height="824" rx="180" fill="#0C1119"/><g transform="translate(512 512) scale(1.356) translate(-256 -256)">MARK</g></svg>
```

Write the results to:

- `dev/app-icon.icon/Assets/text.svg` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon/Assets/text.svg` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon/Assets/text.svg` -> `prod/black-macos-1024.png`

Run `/opt/homebrew/bin/rsvg-convert -w 1024 -h 1024 input.svg -o output.png`. The plate remains 824×824 and inset 100 pixels on every side; the transform centres the horned body while the tail extends right.

Do not edit the generated PNG or ICO files directly.

## Android launcher and splash artwork

Android masks the central 72dp of a 108dp adaptive canvas, and the Android 12+ splash screen masks
the central two thirds of a 288dp canvas, so the Icon Composer exports cannot be used directly:
their rounded-square silhouette gets framed again and the wordmark is cropped. The Android artwork
is instead rendered from the same Icon Composer SVG sources by `vp run icons:export:android`:

- `apps/mobile/assets/android-icon-foreground.png`: the shared transparent wordmark, sized to stay
  inside the safe zone
- `apps/mobile/assets/android-icon-background-dev.png` and `-nightly.png`: full-bleed variant
  artwork (blueprint grid and annotations; night sky and clouds). Production uses a solid color.
- `apps/mobile/assets/android-splash-icon-*.png`: the two layers composed into one 288dp image, so
  the splash mask reproduces the launcher icon's framing.

Rerun the export after changing a layer SVG. `android-icon-mark.png` remains a flat silhouette for
Android's monochrome themed icon.
