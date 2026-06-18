# Local testing loops for human↔human and human↔agent

**Date:** 2026-06-18
**Status:** Design — approved, pending implementation plan

## Problem

A coding agent (running without a TTY) needs to exercise a hisohiso branch
end-to-end from inside its git worktree, against that worktree's isolated Docker
relay. Two flows matter:

- **human↔human** — multiple PWA instances in the same room round-tripping
  encrypted messages.
- **human↔agent** — a daemon-spawned agent room that a "phone" joins and talks
  to.

Today this is a hand-driven, partly-manual procedure (`docs/local-worktree-testing.md`):
the detached relay launch is copy-pasted bash, and `daemon start` / `wrap` both
block on a **hidden TTY prompt** for the session knock message, so an agent/harness
cannot pair without a human. There is no browser-level (PWA) automation at all —
`app/` ships only headless contract tests.

## Goal

One orchestrator entrypoint, runnable by an agent with no TTY, that brings up the
worktree's isolated relay and runs the two flows with assertions, plus a
one-command **manual fallback** for the irreducibly-interactive QR-scan path.
Automate everything that can be; keep the manual door for what can't.

## Key insight

The **joiner** never needed a TTY. Auto-approval gates on
`session knock message + per-room pairing code` (both factors fold into the
PBKDF2 `k_knock` derivation — see `cli/src/lib/crypto.ts`, `wrap.ts:81`). A joiner
that possesses room secret + pairing code + knock message can knock and be
auto-admitted with **no QR scan**. The only TTY dependency is on the
**daemon/wrap side**, where `promptLine` (hidden) collects the knock message.
Sourcing that one value from an env var unblocks fully-headless pairing.

## Architecture

Layered behind a single orchestrator. The fast layer is the agent's constant
inner loop; the fidelity layer exercises the real PWA on demand; both run against
the same isolated per-worktree relay.

```
worktree path ──► derived env (port/project/JWT/VAPID) ──► Docker relay (loopback)
                                                              ▲        ▲        ▲
                            headless test clients ────────────┘        │        │
                            Playwright Chromium contexts ───────────────┘        │
                            isolated daemon (~/.hisohiso-test) ──────────────────┘
```

### Components

1. **`scripts/lib/worktree-env.mjs`** — extracted from `scripts/dev.mjs`. Pure
   function: given `cwd`, return `{ project, port, pubKey, subKey }` (the
   existing sha256-of-path derivation). `dev.mjs` is refactored to consume it so
   there is exactly one source of truth for the per-worktree mapping. VAPID
   load/create stays in `dev.mjs` (it has filesystem side effects).

2. **`scripts/relay.mjs up|down|status`** — promotes today's documented bash into
   code. `up` runs `docker compose up -d --build` with the derived env, then
   polls `/api/stats` until healthy (bounded timeout). `down` runs
   `docker compose down` with the same `COMPOSE_PROJECT_NAME`. `status` reports
   container health + URL. Detects a stopped Docker daemon and fails with the
   documented remedy.

3. **Non-interactive pairing (CLI change)** — in `cli/src/commands/wrap.ts` and
   the daemon's control-room setup (`cli/src/commands/daemon.ts` →
   `setupControlRoom`), read the session knock message from
   `HISOHISO_KNOCK_MESSAGE` when set, bypassing the hidden `promptLine`. Mirrors
   the existing `HISOHISO_SERVICE` / `!process.stdin.isTTY` handling
   (`daemon.ts:42`, `daemon.ts:75`). When the env var is set, no TTY is required.
   When unset, behaviour is unchanged (interactive prompt). Empty value is
   rejected exactly as the prompt path rejects an empty line.

4. **`cli/src/lib/test-client.ts`** — a headless "virtual participant" composed
   from the **existing** libs (`crypto.ts`, `api-client.ts`, `sse-client.ts`).
   No new protocol code. Capabilities:
   - `createRoom()` / `joinRoom(url#secret, code?)`
   - `knockAndAwaitApproval(knockMessage)` — produces a decryptable knock and
     waits for the wrapped token (the joiner half of `wrap.ts`'s `onKnock`).
   - `send(text)` / `nextMessage()` — encrypt out, await + decrypt inbound over
     SSE.
   Importable from the orchestrator and from Playwright fixtures.

5. **`scripts/test-loop.mjs`** — the orchestrator. Modes:
   - `--fast` (default): relay up → **human↔human** (client A creates a room,
     client B joins by secret; A→B and B→A each assert identical decrypted
     plaintext) → **human↔agent** (a client pairs the daemon control room using
     `HISOHISO_KNOCK_MESSAGE`, sends `bash`, joins the returned agent room,
     sends a line, asserts the echoed reply) → teardown. Seconds; offline;
     deterministic.
   - `--browser`: relay up → Playwright launches 2+ Chromium contexts against the
     relay URL, creates/joins a room via the **actual PWA UI**, asserts the typed
     message renders A→B; then drives a browser into a daemon-spawned agent room.
   - `--manual`: relay up + daemon in foreground; prints the URL(s) and the knock
     message for a human to drive the genuine QR-scan path. Wraps today's manual
     procedure.

6. **`e2e/`** — Playwright workspace: `playwright.config.ts`,
   `human-to-human.spec.ts`, `human-to-agent.spec.ts`. The orchestrator owns the
   Docker relay lifecycle; Playwright does not (the relay is a built bundle, not
   a `vite dev` server). Chromium only; headless by default, `--headed` opt-in.

## The agent leg of the fast loop

The fast loop's human↔agent leg uses the built-in **`bash`** agent, not real
`claude`: it is deterministic, offline, and fast, so the loop asserts the
*transport* (pair → spawn → join → prompt → reply round-trip) without depending
on a model. Driving real `claude` is available via `--browser`/`--manual` or a
future `--agent claude` flag, but is out of scope for the default loop.

## Isolation

- Test daemon state lives under **`~/.hisohiso-test`** (`HISOHISO_HOME`),
  distinct from the operator's `~/.hisohiso-dev` and real `~/.hisohiso`, so an
  agent's loop never disturbs a human's running dev daemon.
- The relay is the standard per-worktree isolated stack (loopback-only port,
  per-worktree project name + JWT keys). Multiple worktrees run in parallel
  unchanged.

## Error handling

- **Docker daemon off** → detect via `docker info`, fail with the documented
  remedy (`open -a Docker` then poll), do not hang.
- **Health-wait timeout** → bounded poll on `/api/stats`; fail loudly with the
  container status dump.
- **`app/node_modules` poisons the build** → orchestrator refuses to build with a
  host `app/node_modules` present (the existing gotcha), with a clear message.
- **Stale cross-worktree pairing** in `~/.hisohiso-test` → `--fresh` wipes it
  (mirrors `daemon start --fresh`).
- **Teardown is trap-guarded** — any assertion failure still tears the stack
  down; nonzero exit code so an agent/CI reads pass/fail. Orphaned stacks are
  never left behind.

## Testing the harness

The `--fast` loop *is* an integration test and is wired into the test scripts so
CI/an agent can invoke it. The extracted `worktree-env.mjs` gets a unit test
asserting determinism (same path → same port/project). The CLI knock-message-
from-env change gets a unit test covering set / empty / unset.

## Out of scope (YAGNI)

- Real-model (`claude`) assertions in the default loop.
- Non-Chromium browsers / mobile-device emulation in Playwright.
- CI wiring beyond making the loop invokable (separate change if wanted).
- Multi-room or >2-participant stress scenarios beyond the basic round-trips.

## Files

| File | Change |
| --- | --- |
| `scripts/lib/worktree-env.mjs` | add (extracted) |
| `scripts/dev.mjs` | modify — consume the helper |
| `scripts/relay.mjs` | add |
| `scripts/test-loop.mjs` | add |
| `cli/src/lib/test-client.ts` | add |
| `cli/src/commands/wrap.ts` | modify — env knock message |
| `cli/src/commands/daemon.ts` | modify — env knock message |
| `e2e/playwright.config.ts` | add |
| `e2e/human-to-human.spec.ts` | add |
| `e2e/human-to-agent.spec.ts` | add |
| `docs/local-worktree-testing.md` | modify — loops section |
