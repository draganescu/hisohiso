---
name: test-worktree
description: Bring up a PR/branch end-to-end for local testing — start its per-worktree Docker relay detached, point an isolated daemon at it, and hand the user the TTY command to pair. Use when asked to "test PR #N", "test the <branch> worktree", or "bring up <branch> locally".
---

# Test a worktree locally

Stand up one branch's full stack so it can be exercised like a real user would:
the **relay** (Docker) detached + survivable, an **isolated daemon** pointed at
it, ending with the one command the user must run in their own terminal because
the daemon needs a TTY.

Canonical reference: `docs/local-worktree-testing.md`. Keep that and this skill
in sync if the procedure changes.

The argument is a PR number (`176`, `#176`) or a branch/worktree name. If none is
given, ask which branch/PR.

## Steps

### 1. Resolve the worktree
```bash
git worktree list
gh pr view <N> --json headRefName,title,state   # if given a PR number
```
Match `headRefName` to a worktree path. If no worktree exists for the branch,
stop and tell the user (don't create one unprompted). All later steps run from
inside that worktree.

### 2. Start the relay, detached
The dev launcher (`scripts/dev.mjs`) derives a deterministic project/port/JWTs
from the worktree path but runs **attached**. For a survivable server, derive
the same env and add `-d`. From the worktree root:
```bash
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
```
Export those four values and run `docker compose up -d --build`. Note the port.

- **Docker daemon off** (`Cannot connect to the Docker daemon`): `open -a Docker`,
  then `until docker info >/dev/null 2>&1; do sleep 2; done`.
- **`app/node_modules` present**: remove it before building (no `.dockerignore`;
  a darwin `node_modules` breaks `vite build` in the Linux image).
- Verify: `docker ps --filter name=<project>` shows `healthy`, and
  `curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:<port>/` is 200.

### 3. Point an isolated daemon at the relay
From the worktree's **`cli/`** dir (not root — root `bun run dev` is the Docker
launcher). Use `HISOHISO_HOME=$HOME/.hisohiso-dev` to keep dev state off prod:
```bash
cd cli
bun install   # if cli/node_modules is missing — else "tsx: command not found"
HISOHISO_HOME=$HOME/.hisohiso-dev bun run dev -- server http://localhost:<port> --yes
```
With no daemon running, `server` just writes config — no TTY needed.

### 4. Hand off the TTY command (do NOT run it yourself)
`daemon start` shows a QR and waits on a hidden knock prompt — it needs a real
TTY and **cannot be backgrounded**. Give the user this to run in their own
terminal:
```bash
cd <worktree>/cli
HISOHISO_HOME=$HOME/.hisohiso-dev bun run dev -- daemon start --fresh
```
Recommend `--fresh` when `~/.hisohiso-dev` holds stale pairing state from a
previous worktree's (now-gone) relay; drop it to resume. Check
`~/.hisohiso-dev/daemon-state.json` / `rooms.json` mtimes to decide.

## Report back
Give the user: worktree path + branch, the URL (`http://localhost:<port>/`),
container health, what was already done (relay up, deps installed, server
configured), and the single TTY command left for them. Mention app edits need
`up -d --build` (no HMR). Offer teardown: `COMPOSE_PROJECT_NAME=<project> docker compose down`.
