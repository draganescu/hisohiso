# Chat for All

Minimal encrypted room chat with no accounts, no cloud message history, and URL-based room sharing.

## Benefits

- Private by default: chat messages are encrypted in the browser before they leave the device.
- Low metadata surface: server routes ciphertext and room events, not readable chat content.
- No account friction: create a room and share a link.
- Local-first history: messages are stored in local IndexedDB on each device.
- Stronger join proof: knocks are encrypted with `room secret + shared passphrase`, so knowing only the URL is not enough to produce a valid knock.
- Fast teardown: disbanding a room removes it server-side and clients wipe local room data when room removal is detected.

## How This Can Be Used

- Ad-hoc private team discussions.
- Temporary incident-response rooms.
- Family or friend group chat without account onboarding.
- One-off coordination threads where room links can be rotated/disbanded quickly.
- Self-hosted encrypted room chat inside an internal network.

## Architecture (Short)

- Frontend: React + Vite (`app/`)
- Backend API: PHP (`server/index.php`)
- Realtime events: Mercure (SSE)
- Reverse proxy/runtime: FrankenPHP + Caddy
- Storage:
  - Server: SQLite for room/token/presence metadata (`/data/chat.sqlite`)
  - Client: IndexedDB for local message history

## Easy Setup (Local, Recommended)

### Prerequisites

- Docker + Docker Compose

### Start

```bash
./run-local.sh
```

Or:

```bash
docker compose up --build
```

App URL:

```text
http://localhost:8087
```

### Stop

```bash
docker compose down
```

## Production Setup (Manual)

### Prerequisites

- A VPS/host that can run Docker Compose
- Ports `80` and `443` reachable from the internet (for Caddy TLS + app traffic)
- DNS pointed at the server (`A` for apex, optional `CNAME`/`A` for `www`)
- `git` installed on the server (required if you use `./scripts/deploy.sh`)

1. Create env file from template:

```bash
cp .env.example .env
```

2. Set real values in `.env`:
- `SERVER_NAME`
- `MERCURE_PUBLISHER_JWT_KEY`
- `MERCURE_SUBSCRIBER_JWT_KEY`
- `MERCURE_HUB_URL`

Example for a public deployment:

```text
SERVER_NAME=hisohiso.org
MERCURE_HUB_URL=https://hisohiso.org/.well-known/mercure
```

3. Run compose with production overrides:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

### Alternative: deploy helper (same command path as CI)

The repo includes `scripts/deploy.sh`, which:

- verifies `.env` exists on the server
- pulls the latest branch from `origin`
- runs `docker compose -f compose.yaml -f compose.prod.yaml up -d --build`

Use it directly on the server:

```bash
./scripts/deploy.sh
```

## Easy VPS Deploy (GitHub Actions, DigitalOcean-ready)

This repo already includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that SSHes into your server and runs `./scripts/deploy.sh` remotely when you push to `main` or `staging`.

### Quick bootstrap from your laptop (optional)

If you are starting from a fresh Ubuntu/Debian droplet, run:

```bash
./deploy.sh
```

Non-interactive example (useful for copy/paste docs or scripting):

```bash
./deploy.sh --host 203.0.113.10 --domain hisohiso.org --yes
```

This helper:

- SSHes to the droplet
- installs Docker (if missing), Compose support, and `git`
- clones the repo to your target directory
- creates `.env` from `.env.example` with generated Mercure JWT keys
- runs `./scripts/deploy.sh` on the server

It is a convenience bootstrap wrapper around the same server-side deploy path used by CI.

### Server one-time setup

1. Provision a VPS (DigitalOcean droplet works fine).
2. Install Docker + Docker Compose plugin and `git`.
3. Clone this repo onto the server (for example `/opt/hisohiso`).
4. Create `.env` from `.env.example` and set:
   - `SERVER_NAME`
   - `MERCURE_PUBLISHER_JWT_KEY`
   - `MERCURE_SUBSCRIBER_JWT_KEY`
   - `MERCURE_HUB_URL`
5. Ensure your domain points to the server and ports `80`/`443` are open.
6. Run `./scripts/deploy.sh` once to validate the server setup.

Important: the GitHub Action does **not** create `.env` on the server. It expects the file to already exist.

### GitHub repository secrets (for auto-deploy)

Add these repository secrets:

- `DO_SSH_KEY`: private SSH key that can log into the server
- `DO_HOST`: server IP or hostname
- `DO_USER`: SSH user (for example `root` or a deploy user)
- `DO_APP_DIR`: path to the repo on the server (for example `/opt/hisohiso`)
- `DO_SSH_PORT`: optional SSH port (defaults to `22`)

### Deploy flow

- Push to `main` or `staging`
- GitHub Action SSHes to the server
- The workflow runs `DEPLOY_BRANCH=<branch> ./scripts/deploy.sh`
- The script pulls the branch and rebuilds/restarts the container stack

This gives you a simple "push-to-deploy" flow after the server is bootstrapped once.

## Security Notes

- Treat the room URL as sensitive.
- Use a strong shared passphrase for join knocks.
- If a room is compromised, disband and create a new one.
- Message history is local to each device; clearing browser storage removes local history.

## Project Structure

```text
app/                React client
server/             PHP API
public/             Landing page assets
compose.yaml        Local container setup
compose.prod.yaml   Production override
run-local.sh        Local startup helper
about.md            Protocol and UX notes
```
