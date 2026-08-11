#!/usr/bin/env bash
# Publish the contents of $DIST to the $GH_PAGES_BRANCH branch.
set -euo pipefail

BRANCH="${GH_PAGES_BRANCH:-gh-pages}"
REMOTE="${GH_PAGES_REMOTE:-origin}"
DIST="${DIST:-dist}"
WORKTREE="${GH_PAGES_WORKTREE:-.gh-pages}"

cd "$(git rev-parse --show-toplevel)"

if [ ! -f "$DIST/index.html" ]; then
  echo "error: no build found in $DIST/ — run 'make build-gh-pages' first" >&2
  exit 1
fi

source_desc="$(git rev-parse --short HEAD)"
git diff --quiet && git diff --cached --quiet || source_desc="$source_desc-dirty"

cleanup() { git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Always start from the published tip so the deploy appends history instead of
# force-overwriting whatever someone else pushed.
git fetch "$REMOTE" "$BRANCH" >/dev/null 2>&1 || true

if git rev-parse --verify --quiet "refs/remotes/$REMOTE/$BRANCH" >/dev/null; then
  git worktree add -B "$BRANCH" "$WORKTREE" "$REMOTE/$BRANCH" >/dev/null
else
  echo "branch $BRANCH does not exist on $REMOTE — creating it"
  git worktree add --detach "$WORKTREE" >/dev/null
  git -C "$WORKTREE" checkout --orphan "$BRANCH" >/dev/null
  git -C "$WORKTREE" rm -rf . >/dev/null 2>&1 || true
fi

find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$DIST/." "$WORKTREE/"
# Without this, Pages runs the output through Jekyll and drops _-prefixed files.
touch "$WORKTREE/.nojekyll"

git -C "$WORKTREE" add -A
if git -C "$WORKTREE" diff --cached --quiet; then
  echo "gh-pages: build identical to published version, nothing to do"
  exit 0
fi

git -C "$WORKTREE" commit -q -m "deploy $source_desc"
git -C "$WORKTREE" push "$REMOTE" "$BRANCH"
echo "gh-pages: pushed $(git -C "$WORKTREE" rev-parse --short HEAD) to $REMOTE/$BRANCH"
