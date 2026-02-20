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

## Production Setup

1. Create env file from template:

```bash
cp .env.example .env
```

2. Set real values in `.env`:
- `SERVER_NAME`
- `MERCURE_PUBLISHER_JWT_KEY`
- `MERCURE_SUBSCRIBER_JWT_KEY`
- `MERCURE_HUB_URL`

3. Run compose with production overrides:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

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
