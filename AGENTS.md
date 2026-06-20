# Agent workflow for this repository

This file is the source of truth for coding agents working in `hisohiso`. Follow it for every repository task unless the human explicitly says otherwise.

## Default lifecycle

1. **Keep `main` current first.**
   - In `/home/vagabond/hisohiso`: `git checkout main && git pull --ff-only origin main`.
   - Before opening or merging a PR, fetch/rebase the task branch on latest `origin/main`.

2. **Track the work in GitHub.**
   - If no issue exists for the task, open one with a concise title, repro/expected behavior, and acceptance notes.
   - Reference the issue number in the branch/worktree name and PR body.

3. **Use an isolated worktree.**
   - Create task worktrees under `.claude/worktrees/` from latest `main`:
     `git worktree add .claude/worktrees/<slug> -b worktree-<issue>-<slug> main`.
   - Do not edit directly on `main` except for emergency recovery explicitly requested by the human.

4. **Reproduce before fixing when possible.**
   - For bugs, add or run the smallest failing repro first.
   - Prefer e2e/browser repros for PWA behavior, and keep them as regression tests.
   - If true reproduction is impossible, document exactly what was attempted and why.

5. **Fix with the narrowest safe change.**
   - Preserve hisohiso’s E2EE/security model; never store room secrets, passwords, or access keys on the server to make tests easier.
   - Prefer local daemon/control-socket/test-harness state for agentic testing.
   - Keep UI behavior consistent across direct route entry, hash-only room switches, mobile/desktop, and reload/catch-up paths.

6. **Verify locally.**
   - Run the focused repro/regression test.
   - Run the fast loop when code touches room/daemon/transport behavior:
     `npx --yes bun scripts/test-loop.mjs --fast --fresh`.
   - Run relevant typechecks/builds when dependencies are present; if a repo tool is blocked by missing config, report that precisely.
   - Avoid leaving `app/node_modules` in a worktree before Docker builds; it poisons the image build.

7. **Commit and PR.**
   - Commit only the intended files.
   - Push the task branch and open a PR against `main`.
   - PR body must include summary, issue link (`Fixes #...` when appropriate), and tests run.

8. **Merge only when explicitly asked.**
   - If the human asks to merge, use admin merge when requested.
   - After merge, ensure the issue is closed/commented, delete the remote branch, pull `main` latest, remove/prune the worktree, and delete local task branches.

## Cleanup checklist

- `git status --short --branch` is clean on `main`.
- `git worktree list` has no stale task worktree for merged work.
- Remote feature branch is deleted.
- Related issue is closed with a comment or via PR auto-close.
- Main is fast-forwarded to the merge commit.

## Shipping CLI / daemon changes (merge is not enough)

Merging a `cli/` change does **not** put it on any running daemon. The installed
binary and the backgrounded daemon keep running the old code until a new release
exists and is pulled down. In particular:

- `hisohiso daemon restart` (and the `restart` control op) only **re-execs the
  same on-disk binary** — it does NOT fetch new code. Use it to bounce a daemon,
  not to upgrade one.
- New code reaches a host only via a **published GitHub Release**: cut one with
  `./cli/scripts/release.sh vX.Y.Z` (bump → `build:all` → commit → tag → push →
  release with the four arch binaries attached). Binaries live only on the
  Release page, never in the repo.
- A host picks up the release by **`hisohiso update`** (downloads + verifies +
  atomically swaps the binary, then bounces the running daemon onto it via the
  `restart` op), or by waiting for the daemon's ~6h auto-update tick.

So the full path for a daemon/CLI fix is: **merge → `release.sh vX.Y.Z` from
`main` → `hisohiso update` on the host** (or wait for auto-update). "Just restart
the daemon" is wrong — restart alone never changes the code.

## Known gotchas (read before debugging these)

- **Message-list scroll / room switcher** — see [`docs/debugging-scroll.md`](./docs/debugging-scroll.md).
  The thread is document-scrolled with an entry "foot-pin"; `/rooms` entry
  remounts while the header switcher does an in-place hash switch. The
  agent/control "switcher lands on oldest message" bug (#224) reproduces **only**
  in the installed iOS PWA (WKWebView), NOT in headless Chromium — debug it
  on-device with the `?scrolldiag=1` overlay, not in the e2e harness.
- **Agent-room e2e dies with `Channel closed` / `Target … has been closed`** —
  that's the headless Chromium process OOM/`/dev/shm`-dying, not your test. The
  fix (`--disable-dev-shm-usage`) is in `e2e/playwright.config.ts`; keep it.
  Details in [`docs/debugging-scroll.md`](./docs/debugging-scroll.md).
