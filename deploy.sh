#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh [options]

Options:
  --host <host>         Droplet IP/hostname (required)
  --domain <domain>     Public domain, e.g. hisohiso.org (required)
  --user <user>         SSH user (default: root)
  --port <port>         SSH port (default: 22)
  --dir <path>          Deploy directory on server (default: /opt/hisohiso)
  --branch <branch>     Git branch to deploy (default: main)
  --repo-url <url>      Git repo URL (default: upstream repo)
  --yes                 Non-interactive; do not prompt for missing optional values
  -h, --help            Show this help

Environment variable equivalents:
  DROPLET_HOST, SERVER_NAME, SSH_USER, SSH_PORT, DEPLOY_DIR, DEPLOY_BRANCH, REPO_URL

Examples:
  ./deploy.sh
  ./deploy.sh --host 203.0.113.10 --domain hisohiso.org --yes
  DROPLET_HOST=203.0.113.10 SERVER_NAME=hisohiso.org ./deploy.sh --yes
EOF
}

AUTO_YES=0
DROPLET_HOST="${DROPLET_HOST:-}"
SERVER_NAME="${SERVER_NAME:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/hisohiso}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/draganescu/hisohiso.git}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      DROPLET_HOST="${2:-}"
      shift 2
      ;;
    --domain)
      SERVER_NAME="${2:-}"
      shift 2
      ;;
    --user)
      SSH_USER="${2:-}"
      shift 2
      ;;
    --port)
      SSH_PORT="${2:-}"
      shift 2
      ;;
    --dir)
      DEPLOY_DIR="${2:-}"
      shift 2
      ;;
    --branch)
      DEPLOY_BRANCH="${2:-}"
      shift 2
      ;;
    --repo-url)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --yes|-y)
      AUTO_YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo >&2
      usage >&2
      exit 1
      ;;
  esac
done

prompt_required() {
  local var_name="$1"
  local prompt_label="$2"
  local current_value="${!var_name:-}"

  if [ -n "$current_value" ]; then
    return
  fi

  if [ "$AUTO_YES" -eq 1 ] || [ ! -t 0 ]; then
    echo "Missing required value: ${var_name}. Provide it via flag or environment variable." >&2
    exit 1
  fi

  read -r -p "$prompt_label: " current_value
  printf -v "$var_name" '%s' "$current_value"
}

prompt_default() {
  local var_name="$1"
  local prompt_label="$2"
  local default_value="$3"
  local current_value="${!var_name:-}"

  if [ -n "$current_value" ] && [ "$AUTO_YES" -eq 1 ]; then
    return
  fi

  if [ "$AUTO_YES" -eq 1 ] || [ ! -t 0 ]; then
    if [ -z "$current_value" ]; then
      printf -v "$var_name" '%s' "$default_value"
    fi
    return
  fi

  read -r -p "$prompt_label [$default_value]: " current_value
  printf -v "$var_name" '%s' "${current_value:-$default_value}"
}

prompt_required DROPLET_HOST "Droplet IP/host"
prompt_required SERVER_NAME "Domain (e.g. hisohiso.org)"
prompt_default SSH_USER "SSH user" "root"
prompt_default SSH_PORT "SSH port" "22"
prompt_default DEPLOY_DIR "Deploy dir" "/opt/hisohiso"
prompt_default DEPLOY_BRANCH "Branch" "main"
prompt_default REPO_URL "Repo URL" "https://github.com/draganescu/hisohiso.git"

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
