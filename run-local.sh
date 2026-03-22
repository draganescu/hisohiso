#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Starting Hisohiso on http://localhost:8087/"
docker compose up --build
