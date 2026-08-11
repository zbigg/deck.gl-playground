#!/usr/bin/env bash
# One-time: point the repo's GitHub Pages site at the gh-pages branch.
# Requires the repo to be public, or a plan that allows Pages on private repos.
set -euo pipefail

BRANCH="${GH_PAGES_BRANCH:-gh-pages}"
REMOTE="${GH_PAGES_REMOTE:-origin}"

slug="$(git remote get-url "$REMOTE" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
body="{\"source\":{\"branch\":\"$BRANCH\",\"path\":\"/\"}}"

if gh api "repos/$slug/pages" >/dev/null 2>&1; then
  printf '%s' "$body" | gh api -X PUT "repos/$slug/pages" --input - >/dev/null
  echo "updated Pages source for $slug -> $BRANCH:/"
else
  printf '%s' "$body" | gh api -X POST "repos/$slug/pages" --input - >/dev/null
  echo "enabled Pages for $slug -> $BRANCH:/"
fi

gh api "repos/$slug/pages" --jq '"site: " + .html_url + " (" + .status + ")"'
