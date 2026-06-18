#!/usr/bin/env bun
// Per-worktree dev launcher. Derives a deterministic compose project name,
// host port, and Mercure JWT keys from the worktree path, then runs
// `docker compose up --build`. Multiple worktrees can run in parallel; each
// gets its own ./data dir (mounted relative to cwd) and its own container set.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateVapidKeypair } from './lib/vapid.mjs';
import { deriveWorktreeEnv } from './lib/worktree-env.mjs';

const cwd = process.cwd();
const { project, port, pubKey, subKey } = deriveWorktreeEnv(cwd);

// Dev VAPID keypair for web push, minted once and cached under ./data (the
// same gitignored volume the dev sqlite lives in) so it stays stable across
// restarts — a rotating key would orphan every subscription in the dev DB.
// Mirrors scripts/gen-vapid.mjs; see server/push.php for how PHP consumes it.
const vapid = await loadOrCreateVapid(join(cwd, 'data', '.vapid-dev.json'));

console.log(`▶  ${project}`);
console.log(`▶  http://localhost:${port}/\n`);

const child = spawn('docker', ['compose', 'up', '--build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    HISOHISO_PORT: String(port),
    MERCURE_PUBLISHER_JWT_KEY: pubKey,
    MERCURE_SUBSCRIBER_JWT_KEY: subKey,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    // NOT a localhost mailto: Apple rejects those (403 BadJwtToken). The sub is
    // just an abuse contact for the push service; any real https:/mailto works.
    VAPID_SUBJECT: 'https://hisohiso.org',
  },
});

const forward = (sig) => () => child.kill(sig);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));

async function loadOrCreateVapid(path) {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // fall through and regenerate a corrupt cache
    }
  }
  const vapid = await generateVapidKeypair();
  mkdirSync(join(cwd, 'data'), { recursive: true });
  writeFileSync(path, JSON.stringify(vapid), { mode: 0o600 });
  return vapid;
}
