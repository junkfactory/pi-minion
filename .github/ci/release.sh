#!/usr/bin/env bash
# Runs inside GitHub Actions on a v* tag push.
set -euo pipefail

TAG="${GITHUB_REF_NAME:-}"
if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "GITHUB_REF_NAME '$TAG' is not a valid release tag." >&2
  exit 1
fi

# The tagged commit must carry the matching package.json version.
# Releases are cut via ./.github/ci/tag.sh, which bumps package.json
# before tagging; a hand-made tag fails loudly here.
PKG_VERSION="$(node -p "require('./package.json').version")"
if [[ "v$PKG_VERSION" != "$TAG" ]]; then
  echo "error: tag $TAG does not match package.json version $PKG_VERSION." >&2
  echo "Releases must be cut via ./.github/ci/tag.sh so the tagged commit carries the right version." >&2
  exit 1
fi

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists; nothing to do."
  exit 0
fi

gh release create "$TAG" --generate-notes --title "$TAG"
