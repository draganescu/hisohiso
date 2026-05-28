#!/usr/bin/env bun
// Per-worktree dev launcher. Derives a deterministic compose project name,
// host port, and Mercure JWT keys from the worktree path, then runs
// `docker compose up --build`. Multiple worktrees can run in parallel; each
// gets its own ./data dir (mounted relative to cwd) and its own container set.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';

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
  },
});

const forward = (sig) => () => child.kill(sig);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
