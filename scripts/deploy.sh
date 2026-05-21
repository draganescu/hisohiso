#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and set SERVER_NAME + Mercure keys." >&2
  exit 1
fi

echo "Pulling latest code..."
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH="${DEPLOY_BRANCH:-main}"
  git fetch origin "$BRANCH"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -B "$BRANCH" "origin/$BRANCH"
  fi
  git pull --ff-only origin "$BRANCH"
fi

COMPOSE_FILES=(-f compose.yaml -f compose.prod.yaml)

echo "Building + starting containers..."
# `docker compose up --build` recreates a single-container service by renaming
# the old container to "<hash>_<service>-1" and creating a new one with the
# original name. If two recreates run close together (or one is interrupted),
# the rename can leave a half-created orphan that blocks the next recreate
# with: "Conflict. The container name <hash>_<service>-1 is already in use".
# We try the normal recreate first; on failure we sweep every container
# labeled with this compose project and retry once. Two-step keeps the
# happy path zero-downtime and recovers automatically from the orphan case.
if ! docker compose "${COMPOSE_FILES[@]}" up -d --build --remove-orphans; then
  echo "Recreate failed — sweeping project containers and retrying..."
  PROJECT="$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]')"
  ORPHANS=$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.ID}}' || true)
  if [ -n "$ORPHANS" ]; then
    echo "$ORPHANS" | xargs docker rm -f
  fi
  docker compose "${COMPOSE_FILES[@]}" up -d --build --remove-orphans
fi

echo "Deploy complete."
