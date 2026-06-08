---
name: hisohiso-release-cli
description: Release the hisohiso CLI (build the 4 binaries, tag, and publish a GitHub Release with assets). Use when asked to cut/ship/release a new CLI version or when bumping cli/package.json version.
---

# Releasing the hisohiso CLI

The CLI ships as prebuilt single-file binaries attached to a **GitHub Release**.
`install.sh` and `hisohiso update` download from `releases/latest/download/`, so
a plain `git tag` is NOT enough — the release with assets must exist.

Version is single-sourced from `cli/package.json` (`pkg.version` is imported in
`cli/src/index.ts` at build time). Bump it first if needed.

## Steps

```sh
cd cli
bun run build:all                  # builds dist/hisohiso-{darwin,linux}-{arm64,x64}
git add -f dist/hisohiso-*         # dist/ is gitignored — force-add the binaries
git commit -m "Build CLI vX.Y.Z binaries"
git tag vX.Y.Z
git push origin main vX.Y.Z
bun run release vX.Y.Z             # scripts/release.sh: creates the GH Release + uploads assets
```

Custom notes:

```sh
RELEASE_NOTES="Fixes #42; adds X" bun run release vX.Y.Z
```

## What `bun run release` checks (scripts/release.sh)

- All four binaries exist in `dist/`.
- The tag exists locally **and** on origin.
- `gh` is authenticated.
- A release for that tag does not already exist.

## Gotchas

- The four `dist/hisohiso-*` binaries are `.gitignored`; you must `git add -f`.
- Tag format is `vX.Y.Z` (e.g. `v0.8.2`). Match `cli/package.json`.
- The running daemon auto-updates on a 6h tick; `wrap`/one-shot users update via
  `hisohiso update`. Both pull the latest GitHub Release.
