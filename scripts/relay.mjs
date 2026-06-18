#!/usr/bin/env bun
// Per-worktree relay lifecycle, promoted from the documented bash in
// docs/local-worktree-testing.md into code. Derives the same deterministic
// env dev.mjs injects (compose project name, host port, Mercure JWT keys,
// cached VAPID keypair) and drives a detached Docker stack:
//   up     — docker compose up -d --build, then poll /api/stats until healthy
//   down   — docker compose down with the same COMPOSE_PROJECT_NAME
//   status — report container health + URL
// Runnable (`bun scripts/relay.mjs up|down|status`) and importable.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deriveWorktreeEnv } from './lib/worktree-env.mjs';
import { generateVapidKeypair } from './lib/vapid.mjs';

// Health-wait is bounded so a wedged container fails loudly instead of hanging.
// Roughly matches the compose healthcheck envelope (start_period + a few
// probe cycles): the relay should be answering /api/stats well inside this.
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_INTERVAL_MS = 1_000;

// Build the env dev.mjs injects into docker compose for a given worktree.
async function relayEnv(cwd) {
  const { project, port, pubKey, subKey } = deriveWorktreeEnv(cwd);
  // Dev VAPID keypair, minted once and cached under ./data so it stays stable
  // across restarts — a rotating key would orphan every subscription in the
  // dev DB. Mirrors scripts/dev.mjs's loadOrCreateVapid.
  const vapid = await loadOrCreateVapid(cwd, join(cwd, 'data', '.vapid-dev.json'));
  return {
    project,
    port,
    composeEnv: {
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
  };
}

async function loadOrCreateVapid(cwd, path) {
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

// Run a command to completion, capturing stdout/stderr. Never rejects on a
// nonzero exit — callers inspect `code` so they can attach context.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err?.message ?? err) }));
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// Stream a command to the parent's stdio (for the noisy `up --build`).
function runInherit(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

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

async function pollHealth(port) {
  const url = `http://localhost:${port}/api/stats`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
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
  const { project, port, composeEnv } = await relayEnv(cwd);
  const url = `http://localhost:${port}/`;

  console.log(`▶  ${project}`);
  console.log(`▶  ${url}\n`);

  const code = await runInherit('docker', ['compose', 'up', '-d', '--build'], { cwd, env: composeEnv });
  if (code !== 0) {
    throw new Error(`docker compose up exited ${code}`);
  }

  const ok = await pollHealth(port);
  if (ok === false) {
    const { stdout } = await run(
      'docker',
      ['compose', 'ps'],
      { cwd, env: composeEnv },
    );
    throw new Error(
      `relay did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s (${url}api/stats).\n${stdout}`,
    );
  }

  return { url, project, port };
}

export async function relayDown(cwd = process.cwd()) {
  const { project, composeEnv } = await relayEnv(cwd);
  const { code, stderr } = await run('docker', ['compose', 'down'], { cwd, env: composeEnv });
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

const RUN_AS_MAIN = import.meta.main ?? (process.argv[1] && import.meta.url === `file://${process.argv[1]}`);

if (RUN_AS_MAIN) {
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
