#!/usr/bin/env bash
# Post one Discord follow-up once a version's npm dist-tags move after its release
# was announced as pending. The claim ref keeps re-runs and promotions to one post;
# the release announcement claims it too when it already said npm was live.
set -euo pipefail
tag="$1"
if [ -z "${DISCORD_RELEASE_WEBHOOK_URL:-}" ]; then echo "Discord webhook secret is unset; skipping."; exit 0; fi
if ! gh api -X POST "repos/${GITHUB_REPOSITORY}/git/refs" \
  -f "ref=refs/discord-announced/${tag}-npm" -f "sha=$(git rev-parse HEAD)" >/dev/null 2>claim.err; then
  if grep -q 'Reference already exists' claim.err; then echo "The npm promotion of ${tag} was already announced; skipping."; else echo "Could not record the npm announcement claim; skipping."; fi
  exit 0
fi
bash .github/scripts/notify-discord-release.sh \
  --project "S2Code npm" \
  --version "$tag" \
  --npm shuv2code \
  --link "npm: the dist-tags now install this version" \
  --link "release: https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}"
