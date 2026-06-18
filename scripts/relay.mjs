#!/usr/bin/env bun
// Per-worktree relay lifecycle, promoted from the documented bash in
// docs/local-worktree-testing.md into code. Derives the same deterministic
// env dev.mjs injects (compose project name, host port, Mercure JWT keys,
// cached VAPID keypair) and drives a detached Docker stack:
//   up     — docker compose up -d --build, then poll /api/stats until healthy
//   down   — docker compose down with the same COMPOSE_PROJECT_NAME
//   status — report container health + URL
// Runnable (`bun scripts/relay.mjs up|down|status`) and importable.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deriveWorktreeEnv } from './lib/worktree-env.mjs';
import { composeEnv } from './lib/compose-env.mjs';
import { run, runInherit } from './lib/proc.mjs';

// Health-wait is bounded so a wedged container fails loudly instead of hanging.
// Roughly matches the compose healthcheck envelope (start_period + a few
// probe cycles): the relay should be answering /api/stats well inside this.
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 1_000;

// Fail loudly when the Docker daemon is down rather than hanging on compose.
async function ensureDockerUp() {
  const { code } = await run('docker', ['info']);
  if (code !== 0) {
    throw new Error(
      'Cannot connect to the Docker daemon. Start it, e.g.:\n' +
      '  open -a Docker   # then wait for it:\n' +
      '  until docker info >/dev/null 2>&1; do sleep 2; done',
    );
  }
}

// The Dockerfile does `COPY ./app/ .` after `npm install`, with no
// .dockerignore, so a host app/node_modules gets baked into the image —
// overwriting the Linux build's binaries with the host's (or failing the
// COPY). Refuse to build until it's gone.
function ensureNoBuildPoison(cwd) {
  const modules = join(cwd, 'app', 'node_modules');
  if (existsSync(modules)) {
    throw new Error(
      `Host app/node_modules present (${modules}) — it will poison the Docker build ` +
      '(no .dockerignore; the Dockerfile COPYs ./app/ wholesale). Remove it first:\n' +
      '  rm -rf app/node_modules',
    );
  }
}

// Resolves true once /api/stats answers OK, false if the deadline passes first.
async function pollHealth(port) {
  const url = `http://localhost:${port}/api/stats`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
}

export async function relayUp(cwd = process.cwd()) {
  await ensureDockerUp();
  ensureNoBuildPoison(cwd);
  const { project, port, env } = await composeEnv(cwd);
  const url = `http://localhost:${port}/`;

  console.log(`▶  ${project}`);
  console.log(`▶  ${url}\n`);

  const code = await runInherit('docker', ['compose', 'up', '-d', '--build'], { cwd, env });
  if (code !== 0) {
    throw new Error(`docker compose up exited ${code}`);
  }

  if (!(await pollHealth(port))) {
    const { stdout } = await run(
      'docker',
      ['compose', 'ps'],
      { cwd, env },
    );
    throw new Error(
      `relay did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s (${url}api/stats).\n${stdout}`,
    );
  }

  return { url, project, port };
}

export async function relayDown(cwd = process.cwd()) {
  const { project, env } = await composeEnv(cwd);
  const { code, stderr } = await run('docker', ['compose', 'down'], { cwd, env });
  if (code !== 0) {
    throw new Error(`docker compose down (${project}) exited ${code}\n${stderr}`);
  }
}

export async function relayStatus(cwd = process.cwd()) {
  const { project, port } = deriveWorktreeEnv(cwd);
  const url = `http://localhost:${port}/`;
  let healthy = false;
  try {
    const res = await fetch(`${url}api/stats`);
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  return { healthy, url, project };
}

if (import.meta.main) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'up') {
      const { url, project } = await relayUp();
      console.log(`✓  ${project} healthy at ${url}`);
    } else if (cmd === 'down') {
      await relayDown();
      console.log('✓  relay down');
    } else if (cmd === 'status') {
      const { healthy, url, project } = await relayStatus();
      console.log(`${healthy ? '✓' : '✗'}  ${project} — ${url} (${healthy ? 'healthy' : 'down'})`);
      process.exit(healthy ? 0 : 1);
    } else {
      console.error('usage: bun scripts/relay.mjs up|down|status');
      process.exit(2);
    }
  } catch (err) {
    console.error(`✗  ${err?.message ?? err}`);
    process.exit(1);
  }
}
