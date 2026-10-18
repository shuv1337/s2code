#!/usr/bin/env bash
# Post a short Discord release announcement via DISCORD_RELEASE_WEBHOOK_URL.
# Vendored from the shared discord-release-notify skill; release.yml runs it after a publish.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: notify-release.sh --project NAME --version SEMVER [options]

Required:
  --project NAME          Project display name (e.g. shuvpi)
  --version VER           SemVer with optional leading v, prerelease and build metadata

Optional:
  --repo owner/repo       Adds a GitHub tag link
  --npm PACKAGE           Adds an npm version link
  --link "label: url"     Extra link line (repeatable)
  --webhook-url URL       Override DISCORD_RELEASE_WEBHOOK_URL (prefer env)
  --dry-run               Print payload; do not POST
  -h, --help              Show help

Environment:
  DISCORD_RELEASE_WEBHOOK_URL   Shared Discord incoming webhook URL

Exit codes:
  0  posted (or dry-run ok)
  1  error
  2  skipped (webhook unset)
EOF
}

PROJECT=""
VERSION=""
REPO=""
NPM_PACKAGE=""
WEBHOOK_URL="${DISCORD_RELEASE_WEBHOOK_URL:-}"
DRY_RUN=0
LINKS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --npm)
      NPM_PACKAGE="${2:-}"
      shift 2
      ;;
    --link)
      LINKS+=("${2:-}")
      shift 2
      ;;
    --webhook-url)
      WEBHOOK_URL="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT" || -z "$VERSION" ]]; then
  echo "error: --project and --version are required" >&2
  usage >&2
  exit 1
fi

VERSION_TRIMMED="${VERSION#"${VERSION%%[![:space:]]*}"}"
VERSION_TRIMMED="${VERSION_TRIMMED%"${VERSION_TRIMMED##*[![:space:]]}"}"
if [[ "$VERSION_TRIMMED" == v* ]]; then
  TAG="$VERSION_TRIMMED"
  SEMVER="${VERSION_TRIMMED#v}"
else
  TAG="v${VERSION_TRIMMED}"
  SEMVER="$VERSION_TRIMMED"
fi

# SemVer 2.0: numeric core/prerelease identifiers cannot have leading zeros;
# build identifiers may. Nonnumeric prerelease identifiers must contain a letter or -.
NUM='(0|[1-9][0-9]*)'
PRE='(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
SEMVER_PATTERN="^${NUM}\\.${NUM}\\.${NUM}(-${PRE}(\\.${PRE})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"
if [[ ! "$SEMVER" =~ $SEMVER_PATTERN ]]; then
  echo "error: invalid version: $VERSION (expected SemVer, e.g. v1.2.3-rc.1+build.42)" >&2
  exit 1
fi

LINES=("**${PROJECT} ${TAG}** is out")

if [[ -n "$NPM_PACKAGE" ]]; then
  LINES+=("npm: https://www.npmjs.com/package/${NPM_PACKAGE}/v/${SEMVER}")
fi

if [[ -n "$REPO" ]]; then
  if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "error: invalid --repo (expected owner/repo): $REPO" >&2
    exit 1
  fi
  LINES+=("tag: https://github.com/${REPO}/tree/${TAG}")
fi

for link in "${LINKS[@]+"${LINKS[@]}"}"; do
  if [[ -n "$link" ]]; then
    LINES+=("$link")
  fi
done

CONTENT=$(printf '%s\n' "${LINES[@]}")

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '%s\n' "$CONTENT"
  exit 0
fi

if [[ -z "$WEBHOOK_URL" ]]; then
  echo "skipped: DISCORD_RELEASE_WEBHOOK_URL is not set" >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 1
fi

PAYLOAD=$(CONTENT="$CONTENT" python3 - <<'PY'
import json, os
print(json.dumps({"content": os.environ["CONTENT"]}))
PY
)

# Never print curl diagnostics or the response body: either can contain parts of the webhook URL.
CURL_STATUS=0
HTTP_CODE=$(
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    --data "$PAYLOAD" \
    "$WEBHOOK_URL" 2>/dev/null
) || CURL_STATUS=$?

if [[ "$CURL_STATUS" -ne 0 ]]; then
  echo "error: Discord webhook request failed (curl exit ${CURL_STATUS})" >&2
  exit 1
fi

if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "204" ]]; then
  echo "error: Discord webhook failed: HTTP ${HTTP_CODE}" >&2
  exit 1
fi

echo "posted Discord release announcement"
printf '%s\n' "$CONTENT"
