# Hisohiso

Minimal encrypted room chat. No accounts, no cloud history, no tracking.

## How it works

- Create a room, get a link. Share it with whoever you want.
- Room secrets live in the URL hash fragment (`/room#SECRET`) — never sent to the server, never in logs.
- Messages are encrypted in the browser (AES-256-GCM) before leaving the device.
- The server only routes ciphertext and room events.
- Message history lives in local IndexedDB on each device.
- Join knocks are encrypted with `room secret + optional passphrase`.
- Anyone can disband a room — server deletes it, all clients wipe local data.
- Installable as a PWA. QR code scanning to join rooms on mobile.

## Use cases

- Ad-hoc private discussions.
- Temporary incident-response rooms.
- Group chat without account onboarding.
- Self-hosted encrypted chat on an internal network.

## Architecture

- **Frontend**: React + Vite (`app/`)
- **Backend API**: PHP (`server/index.php`)
- **Realtime**: Mercure (SSE)
- **Runtime**: FrankenPHP + Caddy
- **Server storage**: SQLite — room/token/presence metadata only (`/data/chat.sqlite`)
- **Client storage**: IndexedDB — encrypted message history

## Local setup

Requires Docker + Docker Compose.

```bash
./run-local.sh
```

App runs at `http://localhost:8087`.

Stop with `docker compose down`.

## Production setup

1. Copy and fill in env values:

```bash
cp .env.example .env
```

Set `SERVER_NAME`, `MERCURE_PUBLISHER_JWT_KEY`, `MERCURE_SUBSCRIBER_JWT_KEY`, `MERCURE_HUB_URL`.

2. Run:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

## Security notes

- The room secret is in the hash fragment — it never appears in HTTP requests, server logs, or Referer headers.
- Use a shared passphrase for stronger knock encryption.
- If a room is compromised, disband and create a new one.
- Clearing browser storage removes local message history.

## Project structure

```text
app/                React client (Vite + Tailwind)
server/             PHP API (single-file)
public/             Static landing page
data/               SQLite database (created at runtime)
Caddyfile           Reverse proxy config
Dockerfile          Multi-stage build
compose.yaml        Local container setup
compose.prod.yaml   Production override
run-local.sh        Local startup helper
LICENSE             GPLv3
```

## License

GPLv3. See [LICENSE](LICENSE).
