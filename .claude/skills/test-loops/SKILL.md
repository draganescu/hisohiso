---
name: test-loops
description: Use when verifying a hisohiso change works end-to-end on the local machine — the human↔human path (two clients in a room) or the human↔agent path (a phone talking to a daemon-spawned agent) — especially headless / with no TTY (CI or a coding agent that can't scan a QR or type into a prompt). Triggers include "test my change end to end", "run the test loop", "does the encrypted round-trip still work", and debugging pairing/knock that hangs.
---

# Local test loops

`scripts/test-loop.mjs` is the one entrypoint that exercises a worktree
end-to-end against its **own isolated per-worktree Docker relay**. It owns the
relay + an isolated test daemon, drives both round-trips programmatically, and
needs **no TTY** — pairing is bypassed with `HISOHISO_KNOCK_MESSAGE` and joins
are driven by `cli/src/lib/test-client.ts`. Teardown is trap-guarded: any
failure still tears the stack down and exits nonzero, so an agent/CI reads
pass/fail and no stack is orphaned.

Canonical reference: `docs/local-worktree-testing.md`. Keep it and this skill in
sync if the procedure changes.

## Quick reference

Run from the **worktree root**. `bun` must be on PATH (`export PATH="$HOME/.bun/bin:$PATH"` if not).

| Goal | Command |
| --- | --- |
| Fast inner loop (default): both round-trips, headless, seconds | `bun scripts/test-loop.mjs` |
| Same, wiping stale test state first | `bun scripts/test-loop.mjs --fast --fresh` (= `bun run test:loop:fresh`) |
| Real PWA in browsers (Playwright) | `bun scripts/test-loop.mjs --browser --fresh` |
| Foreground bring-up for a human to drive (needs a TTY) | `bun scripts/test-loop.mjs --manual` |

`--fast` (the default) asserts the **transport** — create/join/knock/encrypt
round-trips, plus pair→spawn→join→prompt→reply for the agent leg using the
built-in `bash` echo agent (deterministic, offline, no model). Test daemon
state lives under `~/.hisohiso-test`, separate from a human's `~/.hisohiso-dev`
and real `~/.hisohiso`, so the loop never disturbs a running daemon.

**Pick the mode by what you changed.** `--fast` drives headless protocol
clients (`test-client.ts`), so it covers `cli/`, `server/`, and crypto/wire
changes — but it does **not** render the React app, so a change to `app/src`
(PWA UI) is not actually exercised by `--fast`. To verify UI changes, run
`--browser`, which drives the real PWA in Chromium. A typical change touching
both runs `--fast` first (fast feedback), then `--browser`.

## First run in a fresh worktree

```bash
export PATH="$HOME/.bun/bin:$PATH"
( cd cli && bun install )                 # test-client.ts + daemon deps; else "tsx: command not found"
# For --browser only: ( cd e2e && bun install && bunx playwright install chromium )
until docker info >/dev/null 2>&1; do sleep 2; done   # relay needs Docker up
bun scripts/test-loop.mjs --fast --fresh
```

## Common mistakes

- **Wrong invocation.** `test:loop` is a `package.json` script, not a file —
  run `bun run test:loop` OR `bun scripts/test-loop.mjs`, never
  `bun scripts/test:loop`.
- **`app/node_modules` present.** It poisons the Docker build (no
  `.dockerignore`; the Dockerfile COPYs `./app/` wholesale, overwriting the
  Linux binaries). `relay.mjs` refuses to build until it's gone — `rm -rf app/node_modules`.
- **Running Playwright directly.** `e2e/playwright.config.ts` has no `webServer`
  and throws without `HISOHISO_URL`; the orchestrator owns the relay. Always go
  through `bun scripts/test-loop.mjs --browser`.
- **`--manual` headless.** It runs the daemon in the foreground for a human to
  pair from a phone — it needs a real terminal. For headless/agent use, stick to
  `--fast` (or `--browser`).
- **Stale pairing across worktrees.** A previous worktree's now-gone port/JWT in
  `~/.hisohiso-test` causes pairing to hang — add `--fresh` to wipe it.
