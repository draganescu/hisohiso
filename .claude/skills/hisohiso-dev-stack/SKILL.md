---
name: hisohiso-dev-stack
description: Run, test, and debug the hisohiso stack locally (web app, PHP server, Mercure realtime, and the CLI from source). Use when asked to start the app, run the dev server, run tests, or reproduce something locally.
---

# Running hisohiso locally

Stack: **FrankenPHP** (PHP 8.3) with embedded **Caddy** + **Mercure** (SSE),
**SQLite** (WAL) for server metadata, **React + Vite** frontend (`app/`), and the
**`hisohiso` CLI** (`cli/`). Requires Docker + Docker Compose and [Bun](https://bun.sh).

## Start the full stack

```sh
bun dev          # = ./run-local.sh = bun scripts/dev.mjs
```

`scripts/dev.mjs` derives a **stable host port and compose project name from the
worktree path**, so multiple worktrees run in parallel — each gets its own
containers, its own host port (printed on startup), and its own `./data`
SQLite. The printed URL is what you open.

Raw compose (single instance):

```sh
docker compose up -d
docker compose logs -f
docker compose build
```

## Tests

- Server (PHP): tests live in `server/tests/` (e.g. `server/tests/test_rate_limit.php`).
  The documented entry point is `cd server && php tests.php`.
- CLI: `cd cli && bun test` (sync/unit tests under `cli/src/**/*.test.ts`).

## Run the CLI from source

```sh
cd cli
bun install
bun run dev wrap claude        # bridge a wrapped agent to a one-off room (shows a QR)
```

For an isolated second daemon alongside a real one, set `HISOHISO_HOME` to a
throwaway dir (it overrides `~/.hisohiso` for config, PID, rooms, logs).

## Key files

- `scripts/dev.mjs` — the dev launcher (port/project derivation).
- `compose.yaml` / `Caddyfile` / `Dockerfile` — runtime wiring.
- `server/index.php` — the PHP API (`/api/*`).
- `app/` — the React PWA. `data/` — local SQLite (gitignored).
