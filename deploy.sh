#!/usr/bin/env bash
set -euo pipefail

read -r -p "Droplet IP/host: " DROPLET_HOST
read -r -p "Domain (e.g. hisohiso.org): " SERVER_NAME
read -r -p "SSH user [root]: " SSH_USER
read -r -p "SSH port [22]: " SSH_PORT
read -r -p "Deploy dir [/opt/hisohiso]: " DEPLOY_DIR
read -r -p "Branch [main]: " DEPLOY_BRANCH
read -r -p "Repo URL [https://github.com/draganescu/hisohiso.git]: " REPO_URL

SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hisohiso}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/draganescu/hisohiso.git}"

if [ -z "$DROPLET_HOST" ] || [ -z "$SERVER_NAME" ]; then
  echo "Droplet host and domain are required." >&2
  exit 1
fi

echo "Bootstrapping ${SERVER_NAME} on ${SSH_USER}@${DROPLET_HOST}:${SSH_PORT} (${DEPLOY_DIR})"

ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" "$SSH_USER@$DROPLET_HOST" \
  SERVER_NAME="$SERVER_NAME" DEPLOY_DIR="$DEPLOY_DIR" DEPLOY_BRANCH="$DEPLOY_BRANCH" REPO_URL="$REPO_URL" \
  'bash -s' <<'REMOTE'
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap script currently expects Ubuntu/Debian (apt-get)." >&2
  exit 1
fi

echo "Installing base packages..."
$SUDO apt-get update -y
$SUDO apt-get install -y ca-certificates curl git openssl

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | $SUDO sh
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is not available after Docker install." >&2
  echo "Install docker compose plugin, then rerun bootstrap." >&2
  exit 1
fi

echo "Preparing deploy directory..."
$SUDO mkdir -p "$DEPLOY_DIR"

if [ ! -d "$DEPLOY_DIR/.git" ]; then
  $SUDO git clone "$REPO_URL" "$DEPLOY_DIR"
fi

if [ "$($SUDO stat -c %u "$DEPLOY_DIR")" -ne "$(id -u)" ]; then
  $SUDO chown -R "$(id -u):$(id -g)" "$DEPLOY_DIR"
fi

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "Creating .env from template..."
  cp .env.example .env

  MERCURE_PUBLISHER_JWT_KEY="$(openssl rand -hex 32)"
  MERCURE_SUBSCRIBER_JWT_KEY="$(openssl rand -hex 32)"
  MERCURE_HUB_URL="https://${SERVER_NAME}/.well-known/mercure"

  sed -i \
    -e "s|^SERVER_NAME=.*|SERVER_NAME=${SERVER_NAME}|" \
    -e "s|^MERCURE_PUBLISHER_JWT_KEY=.*|MERCURE_PUBLISHER_JWT_KEY=${MERCURE_PUBLISHER_JWT_KEY}|" \
    -e "s|^MERCURE_SUBSCRIBER_JWT_KEY=.*|MERCURE_SUBSCRIBER_JWT_KEY=${MERCURE_SUBSCRIBER_JWT_KEY}|" \
    -e "s|^MERCURE_HUB_URL=.*|MERCURE_HUB_URL=${MERCURE_HUB_URL}|" \
    .env
else
  echo ".env already exists, leaving it unchanged."
fi

echo "Running repo deploy script (branch: ${DEPLOY_BRANCH})..."
DEPLOY_BRANCH="$DEPLOY_BRANCH" ./scripts/deploy.sh

cat <<EOF

Bootstrap complete.

App directory: $DEPLOY_DIR
Domain: $SERVER_NAME

If you want push-to-deploy, add these GitHub repo secrets:
- DO_SSH_KEY
- DO_HOST
- DO_USER
- DO_APP_DIR
- DO_SSH_PORT (optional)

EOF
REMOTE
