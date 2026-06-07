#!/usr/bin/env bun
// Per-worktree dev launcher. Derives a deterministic compose project name,
// host port, and Mercure JWT keys from the worktree path, then runs
// `docker compose up --build`. Multiple worktrees can run in parallel; each
// gets its own ./data dir (mounted relative to cwd) and its own container set.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const cwd = process.cwd();
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
    VAPID_SUBJECT: 'mailto:dev@localhost',
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
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const pemWrap = (der) =>
    `-----BEGIN PRIVATE KEY-----\n${b64(der).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;

  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

  const vapid = {
    publicKey: b64url(rawPub),
    privateKey: b64(Buffer.from(pemWrap(pkcs8))),
  };
  mkdirSync(join(cwd, 'data'), { recursive: true });
  writeFileSync(path, JSON.stringify(vapid), { mode: 0o600 });
  return vapid;
}
