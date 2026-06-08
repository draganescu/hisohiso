# Status updates & in-turn approvals

This feature gives an agent room two things it never had:

1. **Live status** — the operator can see whether the agent is working, sitting
   in a long tool call, gone quiet, or wedged — instead of staring at nothing
   until the whole turn finishes.
2. **In-turn approvals** — the agent can pause mid-turn and ask the operator to
   Allow/Deny a risky tool, answered from the phone, with the answer flowing
   back over the **existing SSE channel** so the turn continues.

Both are built on what the phone already speaks: `progress` / `buttons` /
`confirm-danger` blocks and the `block_response` round-trip used for knock
approvals. No new transport, no app protocol changes.

## What changed

- **No more bypass-by-default.** The built-in `claude` / `codex` profiles no
  longer carry `--dangerously-skip-permissions` /
  `--dangerously-bypass-approvals-and-sandbox`. Launch flags are now derived
  per-turn from the room's **approval mode** (`agent-modes.ts`). New rooms open
  in a **safe** mode (`plan` for Claude, `read-only` for Codex) — never wide
  open. The operator opts into looser modes.
- **Streaming turns.** Claude runs with `--output-format stream-json --verbose`;
  Codex already emits `--json` ndjson. The daemon reads the stream as *state,
  not content* (`turn-status.ts`) and pushes a throttled status block into the
  room. None of the agent's prose is forwarded from the status path.
- **Approval bridge.** `approvals.ts` raises an Allow/Deny `buttons` block and
  awaits the phone's `block_response`. For Claude `ask` mode, `agent-stream.ts`
  bridges the streaming permission request to it and writes the decision back to
  the agent over stdin.
- **Resume is untouched.** Turns still spawn fresh per message and persist the
  provider session id (`--resume` / `exec resume`). A mode change just changes
  the flags used on the next spawn.

## Approval modes (per provider)

| Provider | Modes | Interactive? |
|----------|-------|--------------|
| Claude | `plan` (default) · `ask` · `auto-edits` · `full` | `ask`, `auto-edits` |
| Codex | `read-only` (default) · `ask` · `auto` · `full` | `ask` |

`flagsForMode()` maps each to real CLI flags. The operator changes mode at any
time from the in-room picker (`/mode`, or the picker posted when the room opens);
the change is persisted to `rooms.json` and applies on the next turn.

## Status states

Derived by the runner's event reducer + a 10s heartbeat:

- `● Working` — assistant/thinking events flowing
- `⚙ <tool>` — inside a tool call (between `tool_use` and its result)
- `… Still working (Ns quiet)` — alive but no events for >20s
- `⚠ Possibly stuck (Ns)` — no events for >90s; carries a **Stop** button
- final answer / `✗ Failed` — turn finished

Status is rate-limited (≥12s apart; `stuck` always passes) because the room is
an append-only chat log — there is no in-place message replace yet. That's the
one real follow-up: a `replace_msg_id` on the envelope would let a single status
chip update in place instead of posting milestones.

## Verification status

- **Typechecks** (`npm run typecheck`, CLI). ✅
- **Non-interactive modes** (plan / auto-edits / full / codex read-only / auto)
  use only real, documented provider flags + output streaming — the verifiable
  core.
- **NEEDS LIVE VERIFICATION:** the Claude streaming permission protocol in
  `agent-stream.ts` (`handleClaudeControl`) — the exact `control_request` /
  `control_response` shapes are modeled on the Agent SDK's control channel and
  must be confirmed against the installed `claude` binary before `ask` mode
  leaves draft. It is reached **only** in `ask` mode, so every other mode is
  unaffected.
- **Codex `ask`** via `exec` is best-effort (`--ask-for-approval on-request`);
  true interactive Codex approvals need the app-server path (follow-up).

This PR is opened as a **draft** for that reason.
