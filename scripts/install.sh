#!/bin/sh
# Installs the S2Code CLI from a GitHub Release archive. Needs only sh, tar,
# sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/shuv1337/s2code/main/scripts/install.sh | sh
#
# Environment:
#   S2CODE_CHANNEL           release train to follow: stable, nightly, or preview
#                            (default: nightly, the only train the fork publishes)
#   S2CODE_VERSION           exact version to install (overrides S2CODE_CHANNEL)
#   S2CODE_HOME              Server home directory (default: ~/.s2code-v2-<channel>,
#                            or ~/.s2code-v2 for stable)
#   S2CODE_INSTALL_BIN_DIR   where the `s2code` symlink goes (default: ~/.local/bin)
#   S2CODE_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#
# The archive is unpacked into $S2CODE_HOME/runtime/versions/<version>, the
# same layout `s2code service install` uses, so the service reuses this download
# instead of fetching the release again.
set -eu

# New public names take precedence over deprecated unattended-install inputs.
product_setting() {
  canonical="$(printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  if [ -n "$canonical" ]; then printf '%s' "$canonical"
  else printf '%s' "$2" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'; fi
}
is_product_identity_prefix() {
  case s2code in "$1"*) return 0 ;; esac
  case shuv2code in "$1"*) return 0 ;; esac
  return 1
}
S2CODE_HOME="$(product_setting "${S2CODE_HOME:-}" "${SHUV2CODE_HOME:-}")"
S2CODE_CHANNEL="$(product_setting "${S2CODE_CHANNEL:-}" "${SHUV2CODE_CHANNEL:-}")"
S2CODE_VERSION="$(product_setting "${S2CODE_VERSION:-}" "${SHUV2CODE_VERSION:-}")"
S2CODE_INSTALL_BIN_DIR="$(product_setting "${S2CODE_INSTALL_BIN_DIR:-}" "${SHUV2CODE_INSTALL_BIN_DIR:-}")"
S2CODE_RELEASE_BASE_URL="$(product_setting "${S2CODE_RELEASE_BASE_URL:-}" "${SHUV2CODE_RELEASE_BASE_URL:-}")"
S2CODE_IMPORT_UPSTREAM="$(product_setting "${S2CODE_IMPORT_UPSTREAM:-}" "${SHUV2CODE_IMPORT_UPSTREAM:-}")"
# Existing update clients still use the repository's current published location.
repo="shuv1337/s2code"
base_url="${S2CODE_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
t3_home="${S2CODE_HOME:-$HOME/.s2code-v2}"
bin_dir="${S2CODE_INSTALL_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf '\ns2code install: %s\n' "$1" >&2
  exit 1
}

[ -z "${S2CODE_IMPORT_UPSTREAM:-}" ] || fail "Upstream import is not supported; choose a separate S2CODE_HOME."
if [ -n "${T3CODE_HOME:-}" ] && [ -z "${S2CODE_HOME:-}" ]; then
  printf '%s\n' "s2code: ignoring T3CODE_HOME; use S2CODE_HOME to configure the fork's home." >&2
fi
canonical_dir() (
  if [ -d "$1" ]; then cd -P "$1" && pwd -P
  else printf '%s/%s\n' "$(canonical_dir "$(dirname "$1")")" "$(basename "$1")"
  fi
)

# ANSI stays on stderr, so `curl ... | sh` still gets progress.
interactive=false
if [ -t 2 ] && [ "${TERM:-}" != dumb ]; then interactive=true; fi
reset= bold= muted= accent= green=
if "$interactive" && [ -z "${NO_COLOR:-}" ]; then
  reset="$(printf '\033[0m')"; bold="$(printf '\033[1m')"
  muted="$(printf '\033[2m')"; accent="$(printf '\033[94m')"; green="$(printf '\033[32m')"
fi
step() {
  if "$interactive"; then printf '\r\033[2K  %s%s%s' "$muted" "$1" "$reset" >&2
  else printf '  %s\n' "$1" >&2; fi
}
if "$interactive"; then
  printf '\n%s' "$bold" >&2
  printf '  %s\n' '██████████ ████████ ' >&2
  printf '  %s\n' '    ███       ▄██▀       s2code' >&2
  printf '  %s%s     %sCLI installer%s\n' '    ███       ████▄ ' "$reset" "$muted" "$reset$bold" >&2
  printf '  %s\n' '    ███    ▄     ███' >&2
  printf '  %s\n' '    ███    ███████▀ ' >&2
  printf '%s\n' "$reset" >&2
fi
step "Finding your release..."

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    status="$(curl -sSL -w '%{http_code}' "$1" -o "$2")" || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

mb() {
  tenths=$((($1 * 10 + 524288) / 1048576))
  printf '%s.%s' "$((tenths / 10))" "$((tenths % 10))"
}
# Poll the file written by the downloader; no progress-output parsing or extra request.
download() {
  if ! "$interactive"; then fetch "$1" "$2"; return; fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -D "$2.headers" "$1" -o "$2" 2>"$2.errors" &
  else
    wget -q --server-response "$1" -O "$2" 2>"$2.headers" &
  fi
  download_pid=$!
  previous=-1
  cr="$(printf '\r')"
  while kill -0 "$download_pid" 2>/dev/null; do
    bytes=0; total=0
    if [ -f "$2" ]; then bytes="$(wc -c < "$2")"; fi
    if [ -f "$2.headers" ]; then
      while read -r key value; do
        case "$key" in
          HTTP/*) total=0 ;;
          [Cc]ontent-[Ll]ength:) total="${value%"$cr"}" ;;
        esac
      done < "$2.headers"
    fi
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    if [ "$bytes" -ne "$previous" ]; then
      if [ "$total" -gt 0 ]; then
        percent=$((bytes * 100 / total)); [ "$percent" -le 100 ] || percent=100
        filled=$((percent * 32 / 100)); bar=; rest=; n=0
        while [ "$n" -lt 32 ]; do
          if [ "$n" -lt "$filled" ]; then bar="${bar}■"; else rest="${rest}·"; fi
          n=$((n + 1))
        done
        printf '\r\033[2K  %s%s%s%s%s %3d%%  %s%s / %s MB%s' "$accent" "$bar" "$reset$muted" "$rest" "$reset" "$percent" "$muted" "$(mb "$bytes")" "$(mb "$total")" "$reset" >&2
      else
        printf '\r\033[2K  %sDownloading%s  %s MB' "$muted" "$reset" "$(mb "$bytes")" >&2
      fi
      previous="$bytes"
    fi
    sleep 0.1
  done
  result=0; wait "$download_pid" || result=$?
  download_pid=
  if [ "$result" -ne 0 ]; then
    printf '\n' >&2
    if [ -f "$2.errors" ]; then cat "$2.errors" >&2; else cat "$2.headers" >&2; fi
    return "$result"
  fi
  size="$(mb "$(wc -c < "$2")")"
  printf '\r\033[2K  %s■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■%s 100%%  %s%s / %s MB%s\n' "$accent" "$reset" "$muted" "$size" "$size" "$reset" >&2
  rm -f "$2.headers" "$2.errors"
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); use the desktop app or npm" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

channel="${S2CODE_CHANNEL:-nightly}"
version="${S2CODE_VERSION:-}"
if [ -z "$version" ]; then
  # Tags are v<semver>; the channel is the prerelease identifier, or none for
  # stable. Only tags of the requested train are considered, so a stable
  # install can never pick up a nightly or preview build by accident.
  case "$channel" in
    stable) tag_pattern='v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)' ;;
    nightly | preview) tag_pattern="v\([0-9][^\"]*-${channel}\.[0-9]*\.[0-9]*\)" ;;
    *) fail "S2CODE_CHANNEL must be stable, nightly, or preview" ;;
  esac
  tmp_index="$(mktemp)"
  fetch "https://api.github.com/repos/${repo}/releases?per_page=100" "$tmp_index"
  version="$(sed -n "s/.*\"tag_name\": *\"${tag_pattern}\".*/\1/p" "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a ${channel} release; set S2CODE_VERSION"
fi
case "$version" in
  *-preview.*)
    printf '%s\n' \
      "s2code ${version} is a preview build." \
      "  Preview builds are cut by maintainers from unreleased branches to exercise the release" \
      "  pipeline. They can be broken, receive no fixes, and are never offered as updates." \
      "  Set S2CODE_CHANNEL=nightly (the default) for a supported build." >&2
    if [ "$channel" != "preview" ] && [ -z "${S2CODE_VERSION:-}" ]; then
      fail "refusing a preview build that was not explicitly requested"
    fi
    ;;
esac

stem="s2code-${version}-${platform}-${arch}"
archive="${stem}.tar.gz"
previous_archive="shuv2code-${version}-${platform}-${arch}.tar.gz"
legacy_stem="t3-${version}-${platform}-${arch}"
legacy_archive="${legacy_stem}.tar.gz"
command_name=s2code
prerelease="${version#*-}"
case "$prerelease" in
  nightly.*) command_name=s2code-nightly ;;
  preview.*|pr.*) command_name=s2code-preview ;;
esac
if [ -z "${S2CODE_HOME:-}" ]; then
  case "$prerelease" in
    nightly.*) t3_home="$HOME/.s2code-v2-nightly" ;;
    preview.*|pr.*) t3_home="$HOME/.s2code-v2-preview" ;;
  esac
  legacy_home="$HOME/.shuv2code-v2${command_name#s2code}"
  if [ -d "$legacy_home" ] && [ -n "$(ls -A "$legacy_home" | grep -v '^\.product-identity$')" ]; then
    if [ -d "$t3_home" ] && [ -n "$(ls -A "$t3_home" | grep -v '^\.product-identity$')" ] && [ "$(canonical_dir "$t3_home")" != "$(canonical_dir "$legacy_home")" ]; then
      fail "Both S2Code homes contain state. Choose S2CODE_HOME explicitly; they will not be merged."
    fi
    [ ! -L "$legacy_home/.product-identity" ] && [ -f "$legacy_home/.product-identity" ] || fail "Cannot establish product ownership of the legacy home. Verify it offline and choose S2CODE_HOME explicitly."
    case "$(tr -d '\r\n' < "$legacy_home/.product-identity")" in
      s2code|shuv2code) t3_home="$legacy_home" ;;
      *) fail "Cannot establish product ownership of the legacy home. Verify it offline and choose S2CODE_HOME explicitly." ;;
    esac
  fi
fi
t3_home="$(canonical_dir "$t3_home")"
case "$(printf '%s/' "$t3_home" | tr '[:upper:]' '[:lower:]')" in */.t3/*) fail "Refusing an upstream .t3 home; choose a separate S2CODE_HOME." ;; esac
user_home="$(canonical_dir "$HOME")"
default_fork_home=false
case "$t3_home" in "$user_home/.shuv2code-v2") default_fork_home=true ;; esac
[ ! -L "$t3_home/.product-identity" ] || fail "Refusing linked product metadata."
[ ! -e "$t3_home/.product-identity" ] || [ -f "$t3_home/.product-identity" ] || fail "Product metadata must be a regular file."
if [ -f "$t3_home/.product-identity" ]; then
  home_product="$(tr -d '\r\n' < "$t3_home/.product-identity")"
  is_product_identity_prefix "$home_product" || fail "Home belongs to another product."
else home_product=
fi
if [ "$home_product" != s2code ] && [ "$home_product" != shuv2code ] && [ -d "$t3_home" ] && [ -n "$(ls -A "$t3_home" | grep -v '^\.product-identity$')" ] && ! "$default_fork_home"; then
  fail "Cannot establish product ownership. Choose an empty S2CODE_HOME; verify old custom fork homes offline before adding .product-identity containing s2code."
fi
for child in userdata dev runtime; do
  case "$(canonical_dir "$t3_home/$child")/" in "$t3_home/"*) ;; *) fail "Refusing foreign $child path." ;; esac
done
# A new alias must not replace another installation or an unrelated command.
bin_dir="$(canonical_dir "$bin_dir")"
legacy_command_name="shuv2code${command_name#s2code}"
for command in "$command_name" "$legacy_command_name"; do
  installed_command="$bin_dir/$command"
  if [ -e "$installed_command" ] || [ -L "$installed_command" ]; then
    [ -L "$installed_command" ] || fail "Refusing to replace an existing command: $installed_command"
    link_target="$(readlink "$installed_command")"
    case "$link_target" in /*) ;; *) link_target="$bin_dir/$link_target" ;; esac
    if [ "$command" = "$command_name" ] && [ "$link_target" = "$bin_dir/$legacy_command_name" ]; then
      [ -L "$link_target" ] || fail "Refusing a canonical command without an owned legacy launcher: $installed_command"
      link_target="$(readlink "$link_target")"
      case "$link_target" in /*) ;; *) link_target="$bin_dir/$link_target" ;; esac
    fi
    case "$(canonical_dir "$(dirname "$link_target")")/$(basename "$link_target")" in
      "$t3_home"/runtime/versions/*/t3) ;;
      *) fail "Refusing to replace a command owned by another installation: $installed_command" ;;
    esac
  fi
done
mkdir -p "$t3_home"
home_marker_tmp="$(mktemp "$t3_home/.product-identity.XXXXXX")"
if [ "$home_product" != shuv2code ] && [ "$home_product" != s2code ]; then
  if "$default_fork_home"; then home_product=shuv2code; else home_product=s2code; fi
fi
printf '%s\n' "$home_product" > "$home_marker_tmp"
mv "$home_marker_tmp" "$t3_home/.product-identity"

# The release records its own signing policy. A release without one, or an
# unreadable one, is not an installation failure; the warning is simply skipped.
release_metadata="$(mktemp)"
if fetch "${base_url}/v${version}/release.json" "$release_metadata" 2>/dev/null &&
  grep -q '"unsigned": *true' "$release_metadata"; then
  printf '%s\n' \
    "s2code ${version} is an UNSIGNED build." \
    "  At least one platform was built without signing credentials, so its code signature" \
    "  and notarization are absent and your system may refuse to run it without an override." >&2
fi
rm -f "$release_metadata"

versions_dir="${t3_home}/runtime/versions"
target_dir="${versions_dir}/${version}"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' || fail "Invalid release version."
case "$(canonical_dir "$target_dir")/" in "$t3_home/"*) ;; *) fail "Refusing foreign runtime cache path." ;; esac
[ ! -L "$target_dir/t3" ] || fail "Refusing a linked runtime executable."
[ ! -L "$target_dir/.install-complete" ] || fail "Refusing linked runtime metadata."
[ ! -L "$target_dir/.install-product" ] || fail "Refusing linked runtime product metadata."
product=
if [ -e "$target_dir/.install-product" ]; then
  product="$(tr -d '\r' < "$target_dir/.install-product")" || fail "Could not read runtime product metadata."
  is_product_identity_prefix "$product" || fail "Refusing to reuse or replace a foreign runtime cache."
fi
marker=
if [ -e "${target_dir}/.install-complete" ]; then
  marker="$(tr -d '\r' < "${target_dir}/.install-complete")" || fail "Could not read runtime metadata; refusing to replace the cache."
fi
if [ -x "${target_dir}/t3" ] && { [ "$product" = s2code ] || [ "$product" = shuv2code ]; } && [ "$marker" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  download_pid=
  previous_parent= previous= validated=false committed=false
  cleanup_runtime() {
    [ -z "$download_pid" ] || { kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; }
    if [ "$committed" != true ] && [ -n "$previous" ] && [ -d "$previous" ]; then
      if [ -e "$target_dir" ] || ! mv "$previous" "$target_dir"; then
        printf 'Could not restore runtime. Previous copy: %s; validated replacement: %s\n' "$previous" "$staging" >&2
        return
      fi
    fi
    if [ "$validated" = true ] && [ ! -d "$target_dir" ]; then
      printf 'Validated runtime retained at %s; retry installation or recover it manually.\n' "$staging" >&2
      return
    fi
    rm -rf "$staging"
    [ -z "$previous_parent" ] || rm -rf "$previous_parent" || printf 'Could not remove previous backup: %s\n' "$previous_parent" >&2
  }
  trap cleanup_runtime EXIT
  trap 'printf "\n" >&2; exit 130' INT
  trap 'printf "\n" >&2; exit 143' TERM

  if "$interactive"; then printf '\r\033[2K' >&2; fi
  printf '  %sInstalling%s s2code %s%s%s\n\n' "$muted" "$reset" "$bold" "$version" "$reset" >&2
  step "Downloading..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "s2code ${version} has no release archive for ${platform}-${arch}"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  if ! grep -q " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS"; then
    [ "$home_product" = shuv2code ] || fail "This release predates the S2Code transition. A fresh S2Code home requires the first bridge release; existing verified shuv2code homes can still install it."
    archive="$previous_archive"
    if ! grep -q " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS"; then archive="$legacy_archive"; fi
  fi
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "no release archive for ${platform}-${arch} is listed in SHA256SUMS"
  download "${base_url}/v${version}/${archive}" "${staging}/${archive}"

  step "Verifying the download..."
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting s2code..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"
  printf '%s\n' "$home_product" > "${staging}/.install-product"
  validated=true
  if [ -e "$target_dir" ]; then
    previous_parent="$(mktemp -d "${versions_dir}/.previous-XXXXXX")"
    previous="$previous_parent/runtime"
    mv "$target_dir" "$previous"
  fi
  mv "$staging" "$target_dir" || fail "Could not publish the runtime; restoring the previous copy."
  committed=true
  cleanup_runtime
  trap - EXIT
fi

step "Setting up the s2code command..."
mkdir -p "$bin_dir"
# Installed old updaters only repoint their legacy command.
ln -sfn "${target_dir}/t3" "${bin_dir}/$legacy_command_name"
ln -sfn "${bin_dir}/$legacy_command_name" "${bin_dir}/$command_name"
if "$interactive"; then printf '\r\033[2K' >&2; fi
printf '  %sInstalled s2code %s%s\n\n' "$green" "$version" "$reset" >&2
case ":${PATH}:" in
  *":${bin_dir}:"*) printf '  Run %s%s%s to get started.\n\n' "$bold" "$command_name" "$reset" ;;
  *) printf '  Add %s to your PATH, then run %s%s%s.\n\n' "$bin_dir" "$bold" "$command_name" "$reset" ;;
esac
