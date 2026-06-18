// Unit test for deriveWorktreeEnv: determinism + port range.
// Run: node scripts/lib/worktree-env.test.mjs
import assert from 'node:assert/strict';
import { deriveWorktreeEnv } from './worktree-env.mjs';

// Determinism: same cwd → byte-identical output.
const a = deriveWorktreeEnv('/home/vagabond/hisohiso-test-loops');
const b = deriveWorktreeEnv('/home/vagabond/hisohiso-test-loops');
assert.deepEqual(a, b, 'same cwd must derive identical env');

// Distinct cwd → distinct project (hash suffix guarantees uniqueness).
const other = deriveWorktreeEnv('/home/vagabond/hisohiso');
assert.notEqual(a.project, other.project, 'distinct cwd must derive distinct project');

// Port range: 8087..8286 (200-slot window).
for (const cwd of ['/a', '/b', '/some/deep/worktree/path', '/home/vagabond/hisohiso', a.project]) {
  const { port } = deriveWorktreeEnv(cwd);
  assert.ok(Number.isInteger(port) && port >= 8087 && port <= 8286, `port ${port} out of range for ${cwd}`);
}

// Project name shape: lowercase [a-z0-9-] only.
assert.match(a.project, /^[a-z0-9-]+$/, 'project must be lowercase [a-z0-9-]');

// JWT keys: hex slices of the 32-byte sha256 digest (bytes 2..34 and 4..36,
// clamped to the 32-byte digest length → 30 and 28 bytes respectively).
assert.match(a.pubKey, /^[0-9a-f]{60}$/, 'pubKey must be hash bytes 2..34 as hex');
assert.match(a.subKey, /^[0-9a-f]{56}$/, 'subKey must be hash bytes 4..36 as hex');

console.log('ok - worktree-env');
