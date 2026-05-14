#!/usr/bin/env bash
# Create a GitHub Release for the current CLI build.
#
# Why this exists: a git tag is not a Release. Until a Release with binary
# assets exists, install.sh (which downloads from /releases/latest/download/)
# keeps serving the previous version. Forgetting this step in v0.3.6 shipped
# the pre-PR-#8 binary to anyone who reinstalled.
#
# Usage:
#   ./cli/scripts/release.sh v0.3.7
# or:
#   bun run release v0.3.7
#
# Pre-flight: this script verifies the binaries exist, the tag exists locally
# and on origin, and gh is authenticated. It will not build, commit, or push
# for you — those are still manual so it's obvious what's happening.

set -euo pipefail

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  cat >&2 <<EOF
Usage: $0 <tag>

Example: $0 v0.3.7

Workflow:
  1. cd cli && bun run build:all
  2. git add -f cli/dist/hisohiso-*
  3. git commit -m "Build CLI v0.3.7 binaries"
  4. git tag v0.3.7
  5. git push origin main v0.3.7
  6. $0 v0.3.7
EOF
  exit 1
fi

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$CLI_DIR/dist"

missing=()
for arch in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  if [[ ! -f "$DIST/hisohiso-$arch" ]]; then
    missing+=("hisohiso-$arch")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "Missing binaries in $DIST:" >&2
  for m in "${missing[@]}"; do echo "  - $m" >&2; done
  echo "Run 'bun run build:all' first." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install from https://cli.github.com" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI not authenticated. Run 'gh auth login'." >&2
  exit 1
fi

if ! git rev-parse --verify --quiet "refs/tags/$VERSION" >/dev/null; then
  echo "Tag $VERSION not found locally." >&2
  echo "Create it first: git tag $VERSION && git push origin $VERSION" >&2
  exit 1
fi

if ! git ls-remote --tags origin "$VERSION" | grep -q "$VERSION"; then
  echo "Tag $VERSION not found on origin." >&2
  echo "Push it first: git push origin $VERSION" >&2
  exit 1
fi

if gh release view "$VERSION" >/dev/null 2>&1; then
  echo "Release $VERSION already exists on GitHub. Nothing to do." >&2
  echo "If you need to replace assets, delete it first:" >&2
  echo "  gh release delete $VERSION --yes --cleanup-tag=false" >&2
  exit 1
fi

NOTES="${RELEASE_NOTES:-Built from tag $VERSION.}"

echo "Creating release $VERSION with 4 binaries..."
gh release create "$VERSION" \
  --title "$VERSION" \
  --notes "$NOTES" \
  "$DIST/hisohiso-darwin-arm64" \
  "$DIST/hisohiso-darwin-x64" \
  "$DIST/hisohiso-linux-arm64" \
  "$DIST/hisohiso-linux-x64"

echo "Done. https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$VERSION"
