# Testing a PR locally in its worktree

How to bring up a branch end-to-end on your laptop — the static/app **relay**
in Docker, plus a **daemon** paired against it — so you can exercise a PR the
way a real user would. Each git worktree gets its own isolated stack, so several
branches can run side by side without colliding.

The short version: **start the relay (detached), point an isolated daemon at it,
then start the daemon yourself in a real terminal.** The first two steps an agent
can do for you; the last one you have to run because the daemon needs a TTY.

## 0. Find the worktree

PRs are tested in the branch's git worktree, not the main checkout.

```bash
git worktree list                     # map branches → worktree paths
gh pr view <N> --json headRefName     # which branch a PR is on
```

Everything below runs from inside that worktree directory.

## 1. Bring up the relay (the Docker stack)

`scripts/dev.mjs` derives a **deterministic** compose project name, host port
(8087–8286), and Mercure JWT keys from the worktree's absolute path, then runs
`docker compose up --build`. Determinism is the whole point: the same worktree
always lands on the same port and the same project, so re-runs and teardown
target the same stack.

```bash
bun scripts/dev.mjs        # or: ./run-local.sh   (root of the worktree)
```

That runs **attached** — closing it (SIGTERM) tears the container down. For a
server that survives across sessions, run **detached** by reproducing the same
derived env and adding `-d`:

```bash
# Derive the env this worktree maps to (same algorithm as scripts/dev.mjs):
bun -e '
const { createHash } = require("node:crypto");
const { basename } = require("node:path");
const cwd = process.cwd();
const h = createHash("sha256").update(cwd).digest();
const port = 8087 + (h.readUInt16BE(0) % 200);
const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"") || "hisohiso";
console.log(`COMPOSE_PROJECT_NAME=${slug}-${h.subarray(0,3).toString("hex")}`);
console.log(`HISOHISO_PORT=${port}`);
console.log(`MERCURE_PUBLISHER_JWT_KEY=${h.subarray(2,34).toString("hex")}`);
console.log(`MERCURE_SUBSCRIBER_JWT_KEY=${h.subarray(4,36).toString("hex")}`);
'
# Then, with those four values exported:
COMPOSE_PROJECT_NAME=… HISOHISO_PORT=… MERCURE_PUBLISHER_JWT_KEY=… MERCURE_SUBSCRIBER_JWT_KEY=… \
  docker compose up -d --build
```

Confirm it's healthy:

```bash
docker ps --filter "name=<project>" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:<port>/
```

The app is now at **http://localhost:<port>/**.

### Gotchas

- **Docker daemon off.** `Cannot connect to the Docker daemon` → `open -a Docker`,
  then wait: `until docker info >/dev/null 2>&1; do sleep 2; done`.
- **The app is a built bundle — no HMR.** The Dockerfile runs `vite build` and
  bakes `dist/` into the image. `app/` edits only show up after another
  `docker compose up -d --build`. (`cli/` edits don't need a rebuild — they need
  the daemon process restarted.)
- **`app/node_modules` breaks the build.** There's no `.dockerignore`, so the
  whole `app/` is the build context. A symlinked *or* real host `app/node_modules`
  either fails the `COPY` or overwrites the image's Linux binaries with darwin
  ones. Install host deps only to typecheck, then `rm -rf app/node_modules`
  before building.

## 2. Point an isolated daemon at the relay

The CLI defaults to `https://hisohiso.org` (production). Two things keep local
testing off prod:

- `HISOHISO_HOME=$HOME/.hisohiso-dev` isolates dev state (`config.json`,
  `daemon-state.json`, `rooms.json`) from your real install.
- `server <url>` repoints it at the local relay.

Run from the worktree's **`cli/`** directory (note: `bun run dev` from the
worktree *root* is the Docker launcher; the CLI's `dev` script lives in `cli/`
and is `tsx src/index.ts`):

```bash
cd cli
bun install          # first time in a fresh worktree — otherwise "tsx: command not found"
HISOHISO_HOME=$HOME/.hisohiso-dev bun run dev -- server http://localhost:<port> --yes
```

With no daemon running, `server` just writes config — no prompt, no TTY needed —
and prints `… takes effect on next daemon start`.

## 3. Start the daemon — in a real terminal

`daemon start` renders a pairing **QR** and waits on a hidden **knock** prompt.
Both need a real TTY (`process.stdin.isTTY`), so this step **cannot be
backgrounded** by an agent/harness — run it in your own terminal window:

```bash
cd <worktree>/cli
HISOHISO_HOME=$HOME/.hisohiso-dev bun run dev -- daemon start --fresh
```

- `--fresh` disbands any saved control/agent rooms and issues a new QR. Use it
  when `~/.hisohiso-dev` carries **stale pairing state from a previous worktree's
  relay** (a different, now-gone port/JWT). Drop it to resume existing state.
- Scan the QR / knock from the browser at `http://localhost:<port>` to pair.
  Once paired you can spawn the built-in agents (claude/bash/aider/codex) from
  the control room even with an empty registry.

> `wrap` and the daemon use **separate** inbound SSE handlers (`cli/src/commands/wrap.ts`
> vs `cli/src/lib/room-bridge.ts`). If a PR changes the inbound message contract,
> test the path it actually touches — they don't share code.

## 4. Teardown

From the worktree root, with the same derived env:

```bash
COMPOSE_PROJECT_NAME=<project> docker compose down
```

Stop the daemon with Ctrl-C in its terminal (or `… -- daemon stop` from `cli/`).
Dev state lives in `~/.hisohiso-dev` and persists between runs — wipe it for a
truly clean slate.

## Automated testing loops

The procedure above is the **manual fallback** — the irreducibly-interactive
QR-scan path, where a human drives the real PWA in a browser. For everything that
*can* be automated, `scripts/test-loop.mjs` is one orchestrator entrypoint that
brings up the worktree's relay, runs the flows with assertions, and tears the
stack back down. It is runnable by a coding agent with **no TTY**.

```bash
bun scripts/test-loop.mjs                 # --fast (default)
bun scripts/test-loop.mjs --browser       # real PWA via Playwright
bun scripts/test-loop.mjs --manual        # the §1–4 procedure, one command
bun scripts/test-loop.mjs --fast --fresh  # wipe stale test state first
```

It runs against the **same** per-worktree isolated relay as `scripts/dev.mjs`
(same derived port/project/JWT/VAPID — `scripts/relay.mjs up` promotes the §1
detached-launch bash into code), but the daemon state lives under a **separate**
home, `~/.hisohiso-test` (`HISOHISO_HOME`), distinct from your `~/.hisohiso-dev`
and your real `~/.hisohiso`. An agent's loop never disturbs a daemon you have
running.

### `--fast` (default)

Seconds, offline, deterministic — the inner loop. No browser, no real model. It
brings the relay up, then runs two flows with headless "virtual participants"
(`cli/src/lib/test-client.ts`, composed from the existing `crypto.ts` /
`api-client.ts` / `sse-client.ts` — no new protocol code):

- **human↔human** — client A creates a room, client B joins by secret; A→B and
  B→A each assert the decrypted plaintext round-trips identically.
- **human↔agent** — a client pairs the daemon's control room (non-interactively,
  see below), sends `bash`, joins the returned agent room, sends a line, and
  asserts the echoed reply. The agent leg uses the built-in **`bash`** agent on
  purpose: it asserts the *transport* (pair → spawn → join → prompt → reply)
  without depending on a model. Driving real `claude` is a `--browser` / `--manual`
  job.

Teardown is trap-guarded — any assertion failure still runs `docker compose down`,
and the loop exits nonzero so an agent/CI reads pass/fail. No orphaned stacks.

### `--browser`

Higher fidelity, on demand. Brings the relay up, then Playwright launches 2+
Chromium contexts against the relay URL, creates/joins a room through the **actual
PWA UI**, and asserts the typed message renders A→B; then drives a browser into a
daemon-spawned agent room (`e2e/`). Chromium only, headless by default; pass
`--headed` to watch. The orchestrator owns the Docker relay lifecycle —
Playwright does not (the relay is a built bundle, not a `vite dev` server).

### `--manual`

Wraps the §1–4 procedure into one command: relay up + daemon in the foreground,
printing the URL(s) and the knock message for you to drive the genuine QR-scan
path from a browser. Reach for this when you need a human in the loop — the path
the rest of this doc describes by hand.

### Non-interactive pairing

The joiner never needed a TTY. Auto-approval gates on **session knock message +
per-room pairing code** — both fold into the PBKDF2 `k_knock` derivation
(`cli/src/lib/crypto.ts`), so a joiner that holds room secret + pairing code +
knock message is auto-admitted with **no QR scan**. The only TTY dependency was
on the daemon/`wrap` side, where the hidden `promptLine` collects the knock
message.

Setting **`HISOHISO_KNOCK_MESSAGE`** sources that one value from the environment,
bypassing the prompt — this is what lets the fast loop pair fully headlessly:

```bash
HISOHISO_HOME=$HOME/.hisohiso-test HISOHISO_KNOCK_MESSAGE='loop-secret' \
  bun run dev -- daemon start --fresh
```

When the var is set and non-empty, no TTY is required. Unset → unchanged
interactive behaviour (the hidden prompt). Empty → rejected exactly as an empty
prompt line is. It slots in alongside the existing `HISOHISO_SERVICE` /
`!process.stdin.isTTY` handling, and applies to both `wrap` and the daemon's
control-room setup. The orchestrator sets it for you; you only need it by hand if
you're pairing a headless daemon yourself.

### How a coding agent runs the fast loop

No TTY, no browser, no human:

```bash
bun scripts/test-loop.mjs --fast --fresh   # from the worktree root
echo $?                                     # 0 = pass, nonzero = fail
```

`--fresh` wipes any stale pairing state in `~/.hisohiso-test` (a previous
worktree's now-gone port/JWT — same hazard as `daemon start --fresh`, just on the
test home). The loop derives the relay env, brings the stack up, spawns its own
isolated test daemon with `HISOHISO_KNOCK_MESSAGE` set, runs both round-trips, and
tears everything down on the way out — pass or fail. Read the exit code; the stack
is gone either way.
