#!/usr/bin/env bash
# Release the CLI in one command.
#
#   ./cli/scripts/release.sh v0.4.3
#
# Does the full release end-to-end:
#   1. Pre-flight (tools installed, gh authed, working tree clean, tag free)
#   2. Bumps cli/package.json + cli/src/index.ts to the target version
#   3. Builds the four-arch binary set with `bun run build:all`
#   4. Commits the source-only diff (binaries are NOT committed — cli/dist is
#      gitignored and binaries live ONLY on the GitHub Release page)
#   5. Tags the commit and pushes main + tag to origin
#   6. Creates the GitHub Release and uploads the four binaries as assets
#
# Why no binary commit: install.sh fetches from /releases/latest/download/,
# which serves the assets attached to the Release — never the repo. Past
# tags committed the binaries for archival, which bloated the repo by ~300MB
# every release. This script breaks that convention deliberately. Old tags
# still hold their committed binaries; new releases stay lean.
#
# Recovery if something fails after step 4 (commit/tag/push): a partial
# release is recoverable manually — `gh release create $TAG ... cli/dist/*`
# will pick up where we stopped. The script refuses to proceed if a tag
# or release with the same name already exists.

set -euo pipefail

VERSION_ARG="${1:-}"
if [[ -z "$VERSION_ARG" ]]; then
  cat >&2 <<'EOF'
Usage: ./cli/scripts/release.sh <vX.Y.Z>

Examples:
  ./cli/scripts/release.sh v0.4.3
  ./cli/scripts/release.sh 0.4.3       # leading 'v' optional

The script does everything: bump → build → commit → tag → push → release.
Binaries are uploaded only to the GitHub Release; they are NOT committed.
EOF
  exit 1
fi

# Normalize: 'v0.4.3' and '0.4.3' both accepted.
NUMERIC="${VERSION_ARG#v}"
TAG="v${NUMERIC}"

if ! [[ "$NUMERIC" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be X.Y.Z (got '$NUMERIC')" >&2
  exit 1
fi

CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$CLI_DIR/.." && pwd)"
cd "$REPO_ROOT"

# --- Pre-flight ---

for cmd in git gh bun; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required tool: $cmd" >&2; exit 1; }
done

gh auth status >/dev/null 2>&1 || { echo "gh CLI not authenticated — run: gh auth login" >&2; exit 1; }

# Refuse to start with a dirty tree on the files we're going to edit, so the
# commit at step 4 contains ONLY the version bump.
if [[ -n "$(git status --porcelain -- cli/package.json cli/src/index.ts)" ]]; then
  echo "cli/package.json or cli/src/index.ts has uncommitted changes — commit or stash first" >&2
  exit 1
fi

# Refuse if the tag exists anywhere already.
if git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists locally — delete or pick a new version" >&2
  exit 1
fi
if git ls-remote --tags origin "$TAG" 2>/dev/null | grep -q "refs/tags/$TAG"; then
  echo "Tag $TAG already exists on origin — delete or pick a new version" >&2
  exit 1
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists on GitHub — delete first or pick a new version" >&2
  exit 1
fi

# Must be on main (releasing off a feature branch is almost always wrong).
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Releases must be cut from main (currently on '$CURRENT_BRANCH')" >&2
  exit 1
fi

# Must be up to date with origin/main, otherwise the tag will be ahead of
# a branch that has more commits and the push will fail.
git fetch origin main --quiet
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "Local main is not at origin/main — pull/rebase first" >&2
  echo "  local:  $LOCAL"  >&2
  echo "  origin: $REMOTE" >&2
  exit 1
fi

# --- 1. Bump version ---
echo ">> Bumping cli to $NUMERIC..."
# package.json: only the TOP-LEVEL "version" key. The perl one-liner stops
# after the first replacement so we never rewrite a "version" inside a
# dependency entry by accident.
perl -i -pe 'BEGIN { $n = 0 } if ($n == 0 && /"version":\s*"[^"]+"/) { s/"version":\s*"[^"]+"/"version": "'"$NUMERIC"'"/; $n = 1 }' cli/package.json
perl -i -pe "s/\\.version\\('[^']+'\\)/\\.version('$NUMERIC')/" cli/src/index.ts

grep -q "\"version\": \"$NUMERIC\"" cli/package.json || { echo "Failed to update cli/package.json" >&2; exit 1; }
grep -q "\.version('$NUMERIC')" cli/src/index.ts || { echo "Failed to update cli/src/index.ts" >&2; exit 1; }

# --- 2. Build binaries ---
echo ">> Building binaries..."
( cd cli && bun run build:all )

for arch in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  [[ -f "cli/dist/hisohiso-$arch" ]] || { echo "Missing cli/dist/hisohiso-$arch after build" >&2; exit 1; }
done

# Sanity-check: the local-arch binary should report the new version. Catches
# a broken bump where one of the two version fields silently regressed.
HOST_ARCH=""
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) HOST_ARCH="darwin-arm64" ;;
  Darwin-x86_64) HOST_ARCH="darwin-x64" ;;
  Linux-aarch64) HOST_ARCH="linux-arm64" ;;
  Linux-x86_64) HOST_ARCH="linux-x64" ;;
esac
if [[ -n "$HOST_ARCH" ]]; then
  REPORTED="$("cli/dist/hisohiso-$HOST_ARCH" --version 2>/dev/null || true)"
  if [[ "$REPORTED" != "$NUMERIC" ]]; then
    echo "Built binary reports version '$REPORTED', expected '$NUMERIC'" >&2
    echo "(Did cli/src/index.ts get bumped?)" >&2
    exit 1
  fi
fi

# --- 3. Commit (source only) + tag + push ---
echo ">> Committing source bump (binaries NOT committed)..."
git add cli/package.json cli/src/index.ts
git commit -m "Release CLI $TAG"

git tag "$TAG"
echo ">> Pushing main and $TAG to origin..."
git push origin main "$TAG"

# --- 4. Create GH release with binaries attached ---
echo ">> Creating GitHub Release $TAG with 4 binaries..."
NOTES="${RELEASE_NOTES:-CLI $TAG. Install: curl -fsSL https://hisohiso.org/install.sh | sh}"
gh release create "$TAG" \
  --title "$TAG" \
  --notes "$NOTES" \
  "cli/dist/hisohiso-darwin-arm64" \
  "cli/dist/hisohiso-darwin-x64" \
  "cli/dist/hisohiso-linux-arm64" \
  "cli/dist/hisohiso-linux-x64"

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo
echo "Released. https://github.com/$REPO/releases/tag/$TAG"
