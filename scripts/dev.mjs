#!/usr/bin/env bun
// Per-worktree dev launcher. Derives a deterministic compose project name,
// host port, and Mercure JWT keys from the worktree path, then runs
// `docker compose up --build`. Multiple worktrees can run in parallel; each
// gets its own ./data dir (mounted relative to cwd) and its own container set.
import { spawn } from 'node:child_process';
import { composeEnv } from './lib/compose-env.mjs';

const cwd = process.cwd();
// project/port/JWT keys + cached dev VAPID, shared with relay.mjs so the two
// launchers inject byte-identical compose env.
const { project, port, env } = await composeEnv(cwd);

console.log(`▶  ${project}`);
console.log(`▶  http://localhost:${port}/\n`);

const child = spawn('docker', ['compose', 'up', '--build'], { stdio: 'inherit', env });

const forward = (sig) => () => child.kill(sig);
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 1));
