# shuv2code

The command-line server for [S2Code](https://github.com/shuv1337/s2code), a fork of T3 Code:
a GUI for coding agents (Codex, Claude Code, Cursor, OpenCode and others) that you drive from
the desktop, web or mobile app.

```sh
npm i -g shuv2code
shuv2code --help
```

`npx shuv2code` runs it without installing. The package installs the same program under three
names: `shuv2code`, `s2code` and `s2c`.

## How it works

This package is a small launcher with no native code. The first time it runs, it downloads the
S2Code CLI archive for its exact version and your platform from the
[GitHub Release](https://github.com/shuv1337/s2code/releases). It refuses the archive unless its
SHA-256 matches the checksum published inside this npm package, then caches it and runs it.
Later runs check the cached executable against the hash recorded at install time and download
it again if it changed.

Supported platforms: Linux x64 and arm64 (glibc), macOS on Apple silicon, Windows x64. Other
platforms get a "not supported" error. It needs Node.js 18 or newer.

## Cache

| Platform | Location                                                       |
| -------- | -------------------------------------------------------------- |
| Linux    | `$XDG_CACHE_HOME/s2code/runtime`, or `~/.cache/s2code/runtime` |
| macOS    | `~/Library/Caches/s2code/runtime`                              |
| Windows  | `%LOCALAPPDATA%\s2code\runtime`                                |

It keeps the current version and the one installed before it. `npm uninstall -g shuv2code` does
not remove the cache; delete that `runtime` folder afterwards to free the space. Your S2Code
data lives elsewhere and is not affected.

## Settings

- `S2CODE_RELEASE_BASE_URL` downloads from a mirror instead of GitHub. The checksums in this
  package still apply.
- `S2CODE_DOWNLOAD_TIMEOUT_SECONDS` limits the whole download (default 1800). A download that
  receives no data for 60 seconds (or half that limit, if shorter) stops sooner.

## Coming from `@s2code/cli`

`@s2code/cli` and the `@s2code/t3-<platform>` packages are retired. Replace them with:

```sh
npm uninstall -g @s2code/cli && npm i -g shuv2code
```
