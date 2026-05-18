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

### Offline catch-up (opt-in)

Rooms can optionally turn on an encrypted server-side outbox so devices that
were closed when a message was sent can still receive it on next open.

- Off by default for rooms created in the web app. Anyone in the room can flip
  the toggle from the room menu.
- On by default for rooms created by the `hisohiso` CLI (agent + control
  rooms), since those typically run while the operator is offline.
- The outbox is one isolated SQLite file per room at `/data/rooms/<hash>.sqlite`.
  It stores only ciphertext (the same `encrypted_payload` blob clients send to
  `/message`); the server cannot read message contents.
- Retention: up to 500 newest messages or 24h, whichever comes first.
- Turning catch-up off, or disbanding the room, deletes the file immediately.

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
- **Terminal bridge**: `hisohiso` CLI (`cli/`) — bridges a terminal AI agent to a hisohiso room. Currently supports **Claude** only. See [cli/README.md](cli/README.md).

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
- Participant tokens are never broadcast on the room topic. Each knock carries
  an ephemeral ECDH P-256 public key; the approver wraps the new token to that
  pubkey (HKDF-SHA256 → AES-256-GCM) and publishes the wrapped blob on a
  dedicated `token` event. Only the knocker can derive the shared secret and
  unwrap. A passive subscriber to the room topic learns nothing usable.
- The Mercure hub rejects anonymous subscribers. Every SSE connection presents
  a per-room subscriber JWT (`Authorization: Bearer …`) whose `mercure.subscribe`
  claim covers exactly one room. Events are published with `private=on`, so the
  hub gates each delivery against the subscriber's claim. A token leaked from
  one room cannot read another. Knockers receive a short-lived lobby JWT scoped
  to the room they knocked on, valid only long enough to receive their wrapped
  participant token.
- If a room is compromised, disband and create a new one.
- Clearing browser storage removes local message history.

## Project structure

```text
app/                React client (Vite + Tailwind)
server/             PHP API (single-file)
cli/                hisohiso CLI — terminal agent bridge (see cli/README.md)
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
