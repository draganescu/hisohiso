// Per-worktree environment derivation. Pure function: given a worktree path,
// return a deterministic compose project name, host port, and Mercure JWT keys.
// One source of truth for the per-worktree mapping, shared by scripts/dev.mjs,
// scripts/relay.mjs, and scripts/test-loop.mjs.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export function deriveWorktreeEnv(cwd) {
  const hash = createHash('sha256').update(cwd).digest();

  // 8087..8286 — 200-slot window starting at the historical dev port.
  const port = 8087 + (hash.readUInt16BE(0) % 200);

  // Compose project names must be lowercase + [a-z0-9-]. Derive from the
  // worktree directory name and add a 6-char hash suffix so two worktrees with
  // the same basename (e.g. two clones of `hisohiso`) still get distinct names.
  const slug = basename(cwd).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'hisohiso';
  const project = `${slug}-${hash.subarray(0, 3).toString('hex')}`;

  const pubKey = hash.subarray(2, 34).toString('hex');
  const subKey = hash.subarray(4, 36).toString('hex');

  return { project, port, pubKey, subKey };
}
