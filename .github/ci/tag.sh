#!/usr/bin/env bash
# Release-trigger helper. Run from repo root before pushing.
# Usage: ./.github/ci/tag.sh <version>   (e.g. 0.2.5)
# Set DRY_RUN=1 to run checks and skip tag/push mutations.
set -euo pipefail

cd "$(dirname "$0")/../.."

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <version> (semver, e.g. 0.2.5)" >&2
  exit 1
fi

BOOKMARKS="$(jj bookmark list main)"
if [[ "$BOOKMARKS" != main:* ]]; then
  echo "Local main bookmark not found. Aborting." >&2
  exit 1
fi

STATUS="$(jj status)"
if [[ "$STATUS" != *"working copy has no changes"* ]]; then
  echo "Working copy not clean. Aborting." >&2
  exit 1
fi

TAG="v$VERSION"
TAGS="$(jj tag list)"
if [[ "$TAGS" =~ (^|[[:space:]])${TAG}([[:space:]]|$) ]]; then
  echo "Tag $TAG already exists. Aborting." >&2
  exit 1
fi

echo "==> running build checks"
npm ci
npm run check
npm test

# Auto-update CHANGELOG.md: one bullet per commit subject since the last
# v* tag, inserted as the version's section. Skipped when the section
# already exists, so a hand-written section wins — write your prose first
# and this becomes a no-op. The generated draft rides the release commit.
PREV_TAG="$(jj tag list | awk '{print $1}' | sed 's/:$//' | grep '^v' | sort -V | tail -1 || true)"
BULLETS=""
if [[ -f CHANGELOG.md ]] && grep -q "^## \[$VERSION\]" CHANGELOG.md; then
  echo "==> CHANGELOG already has a [$VERSION] section; leaving it alone"
elif [[ -f CHANGELOG.md ]] && [[ -n "$PREV_TAG" ]]; then
  echo "==> generating CHANGELOG section $VERSION (commits since $PREV_TAG)"
  BULLETS="$(jj log --no-graph --no-pager -r "$PREV_TAG..@" -T 'description.first_line() ++ "\n"' \
    | sed '/^$/d' \
    | sed -E '/^[cC]hore(\([a-zA-Z0-9_.-]+\))?:[[:space:]]+release v/d' \
    | sed -E 's/^[a-z]+(\([a-zA-Z0-9_.-]+\))?:[[:space:]]+//' \
    | awk '{ $1 = toupper(substr($1, 1, 1)) substr($1, 2); print }' \
    | sed 's/^/- /')"
  if [[ -n "$BULLETS" ]]; then
    if [[ -n "${DRY_RUN:-}" ]]; then
      echo "DRY_RUN: CHANGELOG [$VERSION] section would be:"
      echo "$BULLETS"
    else
      TMP="$(mktemp)"
      {
        head -1 CHANGELOG.md
        echo
        echo "## [$VERSION]"
        echo
        echo "$BULLETS"
        echo
        tail -n +2 CHANGELOG.md
      } > "$TMP"
      mv "$TMP" CHANGELOG.md
    fi
  fi
else
  echo "==> no previous tag found; skipping CHANGELOG generation"
fi

# Sync package.json into the release: the tagged commit must carry the
# version it names. npm bumps package.json + package-lock.json without
# touching VCS; the bump is committed on main as `chore: release vX.Y.Z`
# and the tag points at that commit.
#
# Empty-WC handling: after a `jj new main` the working copy is an empty
# commit on top of main. `jj commit` on it would auto-create a new
# undescribed commit and leave the bump in the parent. Instead, describe
# the empty @ FIRST, then `jj commit` folds the bump into that described
# commit — the tag lands on a properly-described release commit.
#
# Where the tag lands: `jj commit` finalizes the working copy and leaves a
# fresh empty commit on top, so the release commit — the one carrying the
# version bump and the description — is @- afterwards. main is set to @- and
# the tag follows main, so both point at that commit. Tagging the empty @
# is what left pi-memory v1.0.0 and pi-bridge.ext v1.2.0/v1.3.0 on a
# descriptionless commit. The release commit is verified by its description
# before anything is tagged or pushed.
if [[ -n "${DRY_RUN:-}" ]]; then
  echo "DRY_RUN: npm version $VERSION --no-git-tag-version"
  echo "DRY_RUN: jj describe -m 'chore: release $TAG'   # if @ is empty"
  echo "DRY_RUN: jj commit -m 'chore: release $TAG'      # if @ has changes"
  echo "DRY_RUN: jj bookmark set main -r @-              # the release commit"
  echo "DRY_RUN: jj tag set $TAG -r main"
  echo "DRY_RUN: jj git push --bookmark main --tag $TAG"
else
  npm version "$VERSION" --no-git-tag-version
  # @ is non-empty (the bump): describe it first if it's the empty
  # scaffold commit, then fold the bump into it.
  if [[ "$(jj log -r @ --no-pager -T 'description')" == "" ]]; then
    jj describe -m "chore: release $TAG"
  fi
  jj commit -m "chore: release $TAG"
  # `jj commit` leaves a fresh empty commit on top, so the release commit is
  # @- now. Verify it before tagging: a wrong target would publish a tag on
  # a descriptionless commit.
  RELEASE_REV="@-"
  RELEASE_DESC="$(jj log -r "$RELEASE_REV" --no-pager -T 'description')"
  if [[ "$RELEASE_DESC" != *"chore: release $TAG"* ]]; then
    echo "Release commit not found at $RELEASE_REV; aborting before tagging." >&2
    exit 1
  fi
  jj bookmark set main -r "$RELEASE_REV"
  jj tag set "$TAG" -r main
  jj git push --bookmark main --tag "$TAG"
fi

echo "Done. The $TAG push triggers the release job."
