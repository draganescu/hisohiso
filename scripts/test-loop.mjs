#!/usr/bin/env bun
// Local test-loop orchestrator. One entrypoint an agent (no TTY) can run to
// exercise a worktree end-to-end against its isolated per-worktree relay:
//
//   --fast (default)  relay up → human↔human round-trip → human↔agent round-trip → down
//   --browser         relay up → daemon up → invoke the e2e Playwright suite → down
//   --manual          relay up + daemon in the foreground; print the URL + knock message
//   --fresh           wipe the test daemon state (~/.hisohiso-test) before running
//
// The fast loop is the agent's inner loop: seconds, offline, deterministic. It
// asserts the *transport* (create/join/knock/encrypt round-trips, and
// pair→spawn→join→prompt→reply for the agent leg) without depending on a model
// — the agent leg drives the built-in `bash` echo agent.
//
// Teardown is trap-guarded: any assertion failure still tears the stack down
// (relay + daemon) and exits nonzero, so an agent/CI reads pass/fail and no
// orphaned stack is left behind.

// Test daemon state lives under ~/.hisohiso-test (distinct from the operator's
// ~/.hisohiso-dev and real ~/.hisohiso), so the loop never disturbs a human's
// running daemon. config.ts resolves HISOHISO_HOME at module load (SOCKET_FILE
// et al. derive from it), so it MUST be set before that module is first
// imported — which is why control-plane.ts is pulled in via dynamic import()
// AFTER this assignment, never as a static import (those are hoisted).
import { homedir } from 'node:os';
import { join } from 'node:path';

const TEST_HOME = join(homedir(), '.hisohiso-test');
process.env.HISOHISO_HOME = TEST_HOME;

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relayUp, relayDown } from './relay.mjs';
import { deriveWorktreeEnv } from './lib/worktree-env.mjs';
import { runInherit } from './lib/proc.mjs';
import { TestClient } from '../cli/src/lib/test-client.ts';

const cwd = process.cwd();
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'cli', 'src', 'index.ts');
const E2E_DIR = join(REPO_ROOT, 'e2e');

// The session knock message every join in this loop authenticates against. A
// fixed test value keeps the loop deterministic; it never rides the wire as
// plaintext (it's the k_knock cleartext gate). Passed to the daemon via
// HISOHISO_KNOCK_MESSAGE so pairing needs no TTY prompt.
const KNOCK_MESSAGE = 'hisohiso-test-loop-knock';

// Bounded waits — a wedged handshake fails loudly instead of hanging the loop.
const DAEMON_READY_TIMEOUT_MS = 30_000;
const AGENT_ROOM_TIMEOUT_MS = 30_000;
const MESSAGE_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (msg) => console.log(`▶  ${msg}`);

// ── flag parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const headed = argv.includes('--headed');
let mode = 'fast'; // --fast (or no flag) is the default
if (argv.includes('--browser')) mode = 'browser';
else if (argv.includes('--manual')) mode = 'manual';

// ── test-daemon lifecycle ─────────────────────────────────────────────────────
// Seed the test home so the daemon talks to THIS worktree's relay and can spawn
// the `bash` echo agent. config.json points the daemon at the relay; registry.json
// registers `bash` as a plain echo command (deterministic, offline) — there is no
// built-in bash profile, so a registered echo is the loop's stand-in for it.
function seedTestHome(server) {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(join(TEST_HOME, 'config.json'), JSON.stringify({ server }, null, 2) + '\n', 'utf8');
  writeFileSync(
    join(TEST_HOME, 'registry.json'),
    JSON.stringify([{ name: 'bash', command: 'echo', mode: 'oneshot' }], null, 2) + '\n',
    'utf8'
  );
}

let daemonChild = null;

// Spawn `daemon start --fresh` headless: no TTY, so HISOHISO_KNOCK_MESSAGE
// bypasses the hidden knock-message prompt. Resolves once the control socket
// answers `status` (bounded). Server passed via the seeded config.json.
async function startDaemon(server) {
  seedTestHome(server);
  daemonChild = spawn('bun', [CLI_ENTRY, 'daemon', 'start', '--fresh'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      HISOHISO_HOME: TEST_HOME,
      HISOHISO_KNOCK_MESSAGE: KNOCK_MESSAGE,
    },
  });
  daemonChild.on('exit', () => { daemonChild = null; });

  // Wait for the control socket to come up. Imported lazily so config.ts reads
  // the already-set HISOHISO_HOME (SOCKET_FILE is derived from it at load).
  const { sendControlRequest } = await import('../cli/src/lib/control-plane.ts');
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  for (;;) {
    try {
      await sendControlRequest({ op: 'status' });
      return;
    } catch {
      // socket not up yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`test daemon did not come up within ${DAEMON_READY_TIMEOUT_MS / 1000}s`);
    }
    await sleep(500);
  }
}

async function stopDaemon() {
  if (!daemonChild) return;
  const child = daemonChild;
  daemonChild = null;
  child.kill('SIGTERM');
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(250);
  }
  child.kill('SIGKILL');
}

// ── flows ─────────────────────────────────────────────────────────────────────
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Read messages from a paired client until one contains `needle`, draining any
// already-queued traffic (e.g. the control room's "Daemon online." welcome) so
// an assertion isn't tripped by an unrelated earlier message.
async function awaitText(client, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`awaitText: never saw ${JSON.stringify(needle)} within ${timeoutMs}ms`);
    }
    const msg = await client.nextMessage({ timeoutMs: remaining });
    if (msg.text.includes(needle)) return msg;
  }
}

// human↔human: A creates a room, B joins by secret + code and knocks in; assert
// A→B and B→A each decrypt to the identical plaintext.
async function runHumanToHuman(server) {
  log('human↔human: A creates a room, B joins by secret');
  const a = await TestClient.createRoom(server);
  const clients = [a];
  try {
    const b = await TestClient.joinRoom(server, a.joinUrl, a.pairingCode);
    clients.push(b);
    await b.knockAndAwaitApproval(KNOCK_MESSAGE);

    const aToB = `A→B ${Date.now()}`;
    await a.send(aToB);
    const gotB = await b.nextMessage({ timeoutMs: MESSAGE_TIMEOUT_MS });
    assertEqual(gotB.text, aToB, 'human↔human A→B');

    const bToA = `B→A ${Date.now()}`;
    await b.send(bToA);
    const gotA = await a.nextMessage({ timeoutMs: MESSAGE_TIMEOUT_MS });
    assertEqual(gotA.text, bToA, 'human↔human B→A');

    log('human↔human ✓');
  } finally {
    for (const c of clients) await c.close().catch(() => {});
  }
}

// human↔agent: pair the daemon's control room (HISOHISO_KNOCK_MESSAGE set),
// spawn the `bash` echo agent, join the agent room it mints, send a line and
// assert the echoed reply. The agent join material is read from the test home's
// rooms.json (the join-room action the daemon posts rides the control-room SSE
// envelope, which TestClient intentionally doesn't surface).
async function runHumanToAgent(server) {
  log('human↔agent: pairing the daemon control room');
  await startDaemon(server);
  const { sendControlRequest } = await import('../cli/src/lib/control-plane.ts');

  const clients = [];
  try {
    const { joinUrl, pairingCode } = await sendControlRequest({ op: 'pair' });
    const control = await TestClient.joinRoom(server, joinUrl, pairingCode);
    clients.push(control);
    await control.knockAndAwaitApproval(KNOCK_MESSAGE);
    log('human↔agent: control room paired');

    // host→control notify (#226): the daemon posts an arbitrary line into the
    // control room over the owner-only socket — the path local automation (cron,
    // health checks) uses to ping the phone. Reuse the just-paired control client
    // to assert the line lands, draining the "Daemon online." welcome first.
    const note = `notify-${Date.now()}`;
    const notifyRes = await sendControlRequest({ op: 'notify', text: note });
    if (!notifyRes || notifyRes.delivered !== true) {
      throw new Error(`notify: daemon did not report delivery: ${JSON.stringify(notifyRes)}`);
    }
    await awaitText(control, note, MESSAGE_TIMEOUT_MS);
    log('notify (host→control) ✓');

    // scheduler (#232): add an ephemeral schedule and run it now; assert the
    // daemon ran the agent headless and posted the result into the control room.
    // The bash echo agent echoes the prompt, so making the prompt a hisohiso
    // block-envelope JSON exercises the parse path (#241): the daemon must post
    // the parsed TEXT (+ blocks), NOT the raw JSON. Compact JSON (no spaces) so
    // the `schedule add` token split rejoins it intact.
    const stamp = `blk-${Date.now()}`;
    const envelope = `{"text":"SUMMARY-${stamp}","blocks":[{"type":"list","style":"bullet","items":["x"]}]}`;
    await control.send(`schedule add daily 0 bash ${envelope}`);
    const added = await awaitText(control, 'Scheduled', MESSAGE_TIMEOUT_MS);
    const idMatch = added.text.match(/\[(sch_[a-z0-9]+)\]/i);
    if (!idMatch) throw new Error(`scheduler: no id in add reply: ${JSON.stringify(added.text)}`);
    await control.send(`schedule run ${idMatch[1]}`);
    const result = await awaitText(control, `SUMMARY-${stamp}`, MESSAGE_TIMEOUT_MS);
    // Regression for #241: the message text must be the PARSED envelope text, not
    // the raw block-JSON (which would still contain a "blocks" key).
    if (result.text.includes('"blocks"')) {
      throw new Error(`scheduler: result was raw JSON, not parsed blocks: ${JSON.stringify(result.text)}`);
    }
    log('scheduler (add + run-now → parsed blocks, not raw JSON) ✓');

    // manage UI (#243): `schedules` posts a tappable row per schedule; simulate
    // tapping Pause then Delete via block_response and assert the daemon acts.
    const schedId = idMatch[1];
    await control.send('schedules');
    await awaitText(control, 'Schedules (', MESSAGE_TIMEOUT_MS);
    await control.sendBlockResponse(`sched-row:${schedId}`, `sched-pause:${schedId}`);
    await awaitText(control, `Paused ${schedId}`, MESSAGE_TIMEOUT_MS);
    await control.sendBlockResponse(`sched-row:${schedId}`, `sched-del:${schedId}`);
    await awaitText(control, `Deleted ${schedId}`, MESSAGE_TIMEOUT_MS);
    log('scheduler manage (list + pause + delete via buttons) ✓');

    // Spawn the bash echo agent via the control-room text path ("bash" → spawn).
    await control.send('bash');
    // The daemon replies "Spawning bash…" then "bash session ready." — drain
    // until the room it minted lands in rooms.json.
    const agentRoom = await waitForAgentRoom(control);
    log(`human↔agent: agent room ready (${agentRoom.agentId})`);

    const agent = await TestClient.joinRoom(server, `${server}/room#${agentRoom.roomSecret}`, agentRoom.roomPassword);
    clients.push(agent);
    await agent.knockAndAwaitApproval(KNOCK_MESSAGE);

    const line = `echo-me-${Date.now()}`;
    await agent.send(line);
    // The daemon wraps inbound chat in an <untrusted-peer-message> envelope
    // before handing it to the agent, so the echo reply contains the line
    // rather than equalling it — assert containment.
    const reply = await agent.nextMessage({ timeoutMs: MESSAGE_TIMEOUT_MS });
    if (!reply.text.includes(line)) {
      throw new Error(`human↔agent: echoed reply did not contain ${JSON.stringify(line)}; got ${JSON.stringify(reply.text)}`);
    }
    log('human↔agent ✓');
  } finally {
    for (const c of clients) await c.close().catch(() => {});
  }
}

// Poll the test home's rooms.json (persisted by the daemon on spawn) for the
// first agent room. The control reply also drains so a stuck spawn surfaces.
async function waitForAgentRoom(control) {
  const roomsFile = join(TEST_HOME, 'rooms.json');
  const deadline = Date.now() + AGENT_ROOM_TIMEOUT_MS;
  // Drain the control room concurrently so an error reply doesn't go unnoticed
  // and the SSE stays live; ignore individual message timeouts.
  let draining = true;
  (async () => {
    while (draining) {
      try {
        await control.nextMessage({ timeoutMs: 2_000 });
      } catch {
        // no message in this window — keep draining
      }
    }
  })();
  try {
    for (;;) {
      if (existsSync(roomsFile)) {
        try {
          const rooms = JSON.parse(readFileSync(roomsFile, 'utf8'));
          const room = Array.isArray(rooms)
            ? rooms.find((r) => r && r.roomSecret && r.roomPassword)
            : null;
          if (room) return room;
        } catch {
          // partial write — retry
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`agent room did not appear in rooms.json within ${AGENT_ROOM_TIMEOUT_MS / 1000}s`);
      }
      await sleep(500);
    }
  } finally {
    draining = false;
  }
}

// ── modes ───────────────────────────────────────────────────────────────────
async function runFast() {
  const { url } = await relayUp(cwd);
  const server = url.replace(/\/$/, '');
  await runHumanToHuman(server);
  await runHumanToAgent(server);
}

async function runBrowser() {
  const { url } = await relayUp(cwd);
  const server = url.replace(/\/$/, '');
  // The browser layer drives the real PWA; its human↔agent spec needs a daemon
  // and the control-room join material. Bring the daemon up and export the env
  // the suite consumes (HISOHISO_URL for the relay, plus the test home + knock
  // message + control-room join material for the agent spec).
  await startDaemon(server);
  const { sendControlRequest } = await import('../cli/src/lib/control-plane.ts');
  const { joinUrl, pairingCode } = await sendControlRequest({ op: 'pair' });

  const args = ['playwright', 'test', ...(headed ? ['--headed'] : [])];
  const code = await runInherit('npx', args, {
    cwd: E2E_DIR,
    env: {
      ...process.env,
      HISOHISO_URL: server,
      HISOHISO_HOME: TEST_HOME,
      HISOHISO_KNOCK_MESSAGE: KNOCK_MESSAGE,
      HISOHISO_CONTROL_URL: joinUrl,
      HISOHISO_CONTROL_CODE: pairingCode,
    },
  });
  if (code !== 0) {
    throw new Error(`Playwright suite exited ${code}`);
  }
}

async function runManual() {
  const { url } = await relayUp(cwd);
  const server = url.replace(/\/$/, '');
  console.log('');
  log(`relay:         ${url}`);
  log(`knock message: ${KNOCK_MESSAGE}`);
  console.log('');
  console.log('Starting the daemon in the foreground. Scan the QR with your phone,');
  console.log(`enter the pairing code, and use the knock message above.`);
  console.log('Press Ctrl-C to stop the daemon; the relay is then torn down.\n');
  // Foreground daemon: inherit the TTY so the QR renders. HISOHISO_KNOCK_MESSAGE
  // is still honoured (no hidden prompt) so the operator only scans + types the
  // pairing code. Teardown (trap) brings the relay down on exit.
  seedTestHome(server);
  await runInherit('bun', [CLI_ENTRY, 'daemon', 'start', '--fresh'], {
    env: {
      ...process.env,
      HISOHISO_HOME: TEST_HOME,
      HISOHISO_KNOCK_MESSAGE: KNOCK_MESSAGE,
    },
  });
}

// ── orchestration + trap-guarded teardown ─────────────────────────────────────
let tornDown = false;
async function teardown() {
  if (tornDown) return;
  tornDown = true;
  await stopDaemon().catch(() => {});
  await relayDown(cwd).catch((err) => {
    console.error(`✗  teardown: relay down failed: ${err?.message ?? err}`);
  });
}

// Any exit path — clean, thrown, or signalled — tears the stack down once.
let signalled = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (signalled) return;
    signalled = true;
    teardown().finally(() => process.exit(1));
  });
}

async function main() {
  const { project, port } = deriveWorktreeEnv(cwd);
  log(`${mode} loop — ${project} (port ${port})`);

  if (fresh && existsSync(TEST_HOME)) {
    log(`wiping test daemon state (${TEST_HOME})`);
    rmSync(TEST_HOME, { recursive: true, force: true });
  }

  if (mode === 'browser') {
    await runBrowser();
  } else if (mode === 'manual') {
    await runManual();
  } else {
    await runFast();
  }
}

try {
  await main();
  await teardown();
  console.log('✓  test-loop passed');
  process.exit(0);
} catch (err) {
  console.error(`✗  ${err?.stack ?? err?.message ?? err}`);
  await teardown();
  process.exit(1);
}
