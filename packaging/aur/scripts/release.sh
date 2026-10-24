#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
product_id="${S2CODE_AUR_PRODUCT_ID:?S2CODE_AUR_PRODUCT_ID is required}"
repo="${S2CODE_AUR_RELEASE_REPO:?S2CODE_AUR_RELEASE_REPO is required}"
if [[ "$product_id" != s2code || "$repo" != shuv1337/s2code ]]; then
  echo 'Refusing to publish outside the s2code fork package namespace.' >&2
  exit 1
fi
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
pkgrel="${PKGREL:-1}"
[[ "$pkgrel" =~ ^[1-9][0-9]*$ ]] || { echo 'PKGREL must be a positive integer.' >&2; exit 1; }

if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  pkgname="$product_id-nightly-bin"
else
  echo "Release $tag does not publish an AUR package; this fork publishes only nightly."
  exit 0
fi

version="${tag#v}"
pkgver="${version//-/_}"
asset_name="S2Code-${version}-x86_64.AppImage"
release_json="$(gh api "repos/$repo/releases/tags/$tag")"
asset_digest="$(jq -r --arg name "$asset_name" \
  '.assets[] | select(.name == $name) | .digest' <<<"$release_json")"
appimage_sha256="${asset_digest#sha256:}"

if [[ ! "$appimage_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Release $tag is missing $asset_name or its SHA-256 digest." >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$repo/contents/LICENSE?ref=$tag" > "$work_dir/LICENSE"
license_sha256="$(sha256sum "$work_dir/LICENSE" | awk '{print $1}')"

package_dir="$repo_root/packaging/aur/$pkgname"
grep -qx "pkgname=$pkgname" "$package_dir/PKGBUILD" || { echo 'Package identity does not match the fork publish target.' >&2; exit 1; }
cd "$package_dir"
sed -Ei \
  -e "s/^pkgver=.*/pkgver=$pkgver/" \
  -e "s/^pkgrel=.*/pkgrel=$pkgrel/" \
  -e "/# AppImage$/s/'[^']*'/'$appimage_sha256'/" \
  -e "/# release license$/s/'[^']*'/'$license_sha256'/" \
  PKGBUILD

run_as_builder() {
  if [[ "$(id -u)" == 0 ]]; then
    runuser -u builder -- "$@"
  else
    "$@"
  fi
}

if [[ "$(id -u)" == 0 ]]; then
  chown -R builder:builder "$package_dir"
fi
run_as_builder namcap PKGBUILD
run_as_builder makepkg --printsrcinfo > .SRCINFO
run_as_builder makepkg --syncdeps --cleanbuild --clean --noconfirm
run_as_builder namcap "$(run_as_builder makepkg --packagelist)"

if [[ -z "${AUR_SSH_PRIVATE_KEY:-}" ]]; then
  echo 'AUR_SSH_PRIVATE_KEY is not set; build complete, skipping publish.'
  exit 0
fi

key_file="$work_dir/id_ed25519"
known_hosts_file="$work_dir/known_hosts"
aur_dir="$work_dir/$pkgname"
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > "$key_file"
chmod 600 "$key_file"
printf '%s\n' \
  'aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN' \
  > "$known_hosts_file"
export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=$known_hosts_file -o StrictHostKeyChecking=yes"

aur_remote="ssh://aur@aur.archlinux.org/$pkgname.git"
git clone "$aur_remote" "$aur_dir"
cp PKGBUILD .SRCINFO "$aur_dir/"
cd "$aur_dir"
git config user.name 's2code-ci'
git config user.email 'shuv1337@users.noreply.github.com'
git add -A

if git diff --cached --quiet; then
  echo 'AUR package is already up to date.'
  exit 0
fi

git commit -m "$pkgname: update to $pkgver-$pkgrel"
git push "$aur_remote" HEAD:master
