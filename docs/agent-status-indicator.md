# Agent status indicator

Gives an agent room a **live "agent is working" indicator** — the operator can
see whether the agent is thinking, sitting in a long tool call, or has gone
quiet, instead of staring at nothing until the whole turn finishes.

> **Note — in-turn approvals were dropped.** An earlier version of this branch
> added per-room approval modes and an Allow/Deny round-trip. It was reverted
> (commit `18f0b3d`): Claude's headless `-p` CLI exposes no runtime approval
> protocol (no `control_request`, no `--permission-prompt-tool`) and `codex exec`
> can't answer a mid-run prompt, so every interactive mode silently denied tools.
> Agents launch with the provider's bypass flag and just run, as on `main`.
> Real approvals would need a different transport (Claude Agent SDK / `codex
> mcp-server`) — tracked separately.

## How it works

- **Streaming turns.** Claude runs with `--output-format stream-json --verbose`;
  Codex already emits `--json` ndjson. The daemon reads the stream as **state,
  not content** (`turn-status.ts`) — none of the agent's prose flows through the
  status path.
- **Ephemeral status events.** The daemon sends status as an encrypted,
  per-agent `status` event (`room-bridge` → `server/index.php`). The server
  publishes it over Mercure **without appending to the outbox**, so status never
  pollutes room history.
- **One in-place bubble.** The phone (`RoomController.tsx`) renders a single
  animated "working" indicator that updates as state changes and clears when the
  agent's real reply arrives.

## Status states

Derived by the runner's event reducer (`agent-stream.ts`) + a 10s heartbeat:

- `Working…` — assistant/thinking events flowing
- `<tool>… (Ns)` — inside a tool call; the heartbeat re-sends it as a keepalive
  with elapsed seconds so a long build never looks frozen
- `Still working (Ns)` — alive but no events and **no active tool** for >20s
- `Possibly stuck (Ns)` — no events and no active tool for >90s

A busy tool deliberately never escalates to "stuck" (a long build is not a
stall). The bubble clears on the agent's reply.

## Files

- `cli/src/lib/turn-status.ts` — stream→state reducer + parsers
- `cli/src/lib/agent-stream.ts` — streaming turn runner + heartbeat
- `cli/src/daemon/agent-manager.ts` — emits status during the turn
- `cli/src/lib/room-bridge.ts`, `api-client.ts` — ephemeral status send path
- `server/index.php` — publishes `status` without outbox persistence
- `app/src/pages/RoomController.tsx`, `app/src/lib/room-contracts.ts` — renders
  the in-place indicator
