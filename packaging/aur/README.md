# AUR packaging

This directory retains the channel-generic `s2code-bin` and `s2code-nightly-bin`
recipes, but this fork publishes only `s2code-nightly-bin`. Both repackage the fork's x86_64 AppImage from
[shuv1337/shuv2code releases](https://github.com/shuv1337/shuv2code/releases).
Recipes being present does not mean the AUR packages or a fork release have been published.
Checked-in versions/checksums are deliberately unreleased placeholders; the publisher fills
them from a real release, rather than reusing an upstream artifact or disabling verification.

Stable and nightly install under separate `/opt` directories and own separate
commands, desktop entries, icons and license paths. Each package replaces and
conflicts only with its same-channel legacy package (`shuv2code-bin` or
`shuv2code-nightly-bin`) and retains the old command alias. Neither replaces or
conflicts with upstream or the other fork channel. Preview is not
published to AUR. Artifact names remain `S2Code-<version>-x86_64.AppImage`, matching
the desktop build/release workflow; that filename is not the installed product identity.

## Publishing

AUR publishing is separate from the nightly release pipeline. Run
`.github/workflows/publish-aur.yml` manually for a published nightly tag. It updates
the nightly recipe and checksums, builds it, regenerates `.SRCINFO`, and pushes it
to AUR. Stable and preview tags are skipped. Before enabling it, verify that the
AUR account and SSH key can publish `s2code-nightly-bin`; if an older fork listing
exists, arrange its package merge separately. Package replacement metadata does
not rename or merge AUR records.

The publisher requires `S2CODE_AUR_PRODUCT_ID=s2code` and
`S2CODE_AUR_RELEASE_REPO=shuv1337/shuv2code`. Missing or different identities fail
before release lookup or publishing. AUR SSH URLs are derived only from that guarded
fork identity, never from an arbitrary package target. Without `AUR_SSH_PRIVATE_KEY`,
it builds and validates locally but skips publishing.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
S2CODE_AUR_PRODUCT_ID=s2code S2CODE_AUR_RELEASE_REPO=shuv1337/shuv2code \
  GH_TOKEN=$(gh auth token) RELEASE_TAG=vYOUR_RELEASE_VERSION \
  packaging/aur/scripts/release.sh
```

Homebrew's `t3-code` and Scoop's `extras/t3code` are retained upstream references,
not fork distributions. No fork Homebrew/Scoop package is available.

## Disposable install checks

On Debian/Ubuntu, inspect `dpkg-deb --contents` and `--info` for each fork channel,
then install upstream/stable/nightly in both orders. Launch each command and URL
scheme; remove or upgrade one package and confirm the others' files and launchers remain.
Repeat with preview if distributed.
Upgrade each legacy fork package to its same-channel S2Code package and confirm
both command aliases reach the retained home without taking files from another channel.

On Arch, build with `makepkg`, inspect `pacman -Qlp`, and install upstream plus both
fork packages in both orders. Confirm no file/conflict errors, all three commands launch,
and removing/upgrading either fork package leaves upstream and the other channel usable.
Also upgrade each legacy fork package in place, checking its replacement metadata
and retained command alias.
