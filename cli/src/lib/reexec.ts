// Re-exec the daemon binary in a detached child, then exit. Used by `repair`
// and `server <url>` (#134 pt2): both tear down state, then boot fresh so the
// normal first-run/boot path does the re-pair (no in-loop surgery needed).
//
// Mirrors the auto-updater's proven re-exec (lib/updater.ts) — kept as its own
// helper so the updater's tested swap path stays untouched.

import { spawn } from 'node:child_process';
import { resolveExecPath } from './updater.js';

// extraEnv is merged into the child's environment. `repair`/`server` pass
// HISOHISO_CARRY_KNOCK so the re-pair after teardown reuses the operator's
// session knock message instead of prompting (a detached daemon has no TTY).
export const reExecSelf = (extraEnv: Record<string, string> = {}): void => {
  const execPath = resolveExecPath();
  // argv.slice(2), not slice(1): in a Bun-compiled binary argv is
  // [binary, /$bunfs/<entry>, ...userArgs]; forwarding argv[1] shifts the
  // subcommand and Commander chokes on the /$bunfs path.
  const child = spawn(execPath, process.argv.slice(2), {
    detached: true,
    stdio: 'inherit',
    // HISOHISO_REEXEC tells the child's single-instance guard this is a handoff,
    // not a duplicate — so it waits for us to release the control socket rather
    // than refusing to start.
    env: { ...process.env, HISOHISO_REEXEC: '1', ...extraEnv },
  });
  child.unref();
  // Give the child a beat to grab the resources we're about to release.
  setTimeout(() => process.exit(0), 250);
};
