import { isDaemonRunning, readPid, removePid } from '../daemon/pid.js';
import {
  ensureConfigDir,
  loadDaemonState,
  loadActiveRooms,
  clearDaemonState,
  clearActiveRooms,
  getServer,
} from '../lib/config.js';
import * as api from '../lib/api-client.js';
import { runDaemon, setupControlRoom } from '../daemon/daemon-main.js';
import {
  assertNotRoot,
  isPaired,
  installService,
  uninstallService,
} from '../lib/service.js';

export const daemonStart = async (opts: { fresh?: boolean } = {}): Promise<void> => {
  // Never run the phone-driven daemon as root (#125) — same hard gate as install.
  assertNotRoot('run the daemon');
  await ensureConfigDir();

  if (await isDaemonRunning()) {
    const pid = await readPid();
    console.log(`Daemon is already running (PID: ${pid}).`);
    if (opts.fresh) {
      console.log('Stop it first with `hisohiso daemon stop`, then re-run with --fresh.');
    }
    return;
  }

  if (opts.fresh) {
    await wipeSavedState();
  }

  // Surface the always-on path up front — otherwise it's not obvious `install`
  // even exists. Only in an interactive foreground run (not under a service).
  if (process.stdin.isTTY && !process.env.HISOHISO_SERVICE) {
    console.log('Tip: to keep this running across reboots, run `hisohiso daemon install` (it can pair for you).\n');
  }

  // Runs in foreground: shows QR for phone to join, then enters main loop.
  // Background it with `hisohiso daemon install` (launchd/systemd user service).
  await runDaemon();
};

// Install (or reinstall) the per-user background service so the daemon survives
// logout/reboot and restarts on crash (#125). Gated on: not root. If not paired
// yet, pair inline (when interactive) — a manual `daemon install` has a TTY, so
// it can show the QR and wait on the knock itself; no separate `daemon start`
// needed. Stops any foreground instance so the service manager owns the one PID.
export const daemonInstall = async (): Promise<void> => {
  try {
    assertNotRoot('install the service');
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  if (!(await isPaired())) {
    // No TTY (e.g. a provisioning script) → can't render a QR. Keep the explicit
    // "pair first" refusal for that case.
    if (!process.stdin.isTTY) {
      console.error(
        'No paired control room, and no terminal to show a QR in.\n' +
          'Run `hisohiso daemon start` interactively once to pair, then re-run install.'
      );
      process.exitCode = 1;
      return;
    }
    // Interactive: pair right here. setupControlRoom shows the QR, waits for the
    // phone's knock, and persists the control-room state — then we install.
    console.log('No control room yet — let’s pair first.\n');
    await ensureConfigDir();
    try {
      await setupControlRoom(await getServer());
    } catch (err) {
      console.error(`Pairing failed: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    console.log('\nPaired ✓ — installing the background service…\n');
  }

  // Hand the single instance to the service manager: stop a foreground/old one
  // so RunAtLoad doesn't collide with it on the PID file.
  if (await isDaemonRunning()) {
    console.log('Stopping the running daemon so the service can manage it...');
    await daemonStop();
  }

  try {
    const { manager, unitPath, execPath } = await installService();
    console.log(`Installed and started the hisohiso ${manager} service.`);
    console.log(`  unit:   ${unitPath}`);
    console.log(`  binary: ${execPath}`);
    console.log('It will start on login and restart on crash. Logs: ~/.hisohiso/logs/daemon.log');
    console.log('Stop/remove it with `hisohiso daemon uninstall`.');
  } catch (err) {
    console.error(`Service install failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

// Stop and remove the per-user background service. Safe to run regardless of
// paired state. Composes with the broader `hisohiso uninstall` (#41).
export const daemonUninstall = async (): Promise<void> => {
  try {
    const { manager, removed } = await uninstallService();
    if (removed) {
      console.log(`Removed the hisohiso ${manager} service and stopped the daemon.`);
    } else {
      console.log(`No hisohiso ${manager} service was installed.`);
    }
    console.log('Local state under ~/.hisohiso is preserved.');
  } catch (err) {
    console.error(`Service uninstall failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

// Disband every room we know about server-side, then delete the local state files.
// Order matters: once we drop the participant tokens we can no longer authenticate
// the disband call, so server-side rooms would otherwise linger as zombies.
const wipeSavedState = async (): Promise<void> => {
  const server = await getServer();
  const [savedState, savedRooms] = await Promise.all([
    loadDaemonState().catch(() => null),
    loadActiveRooms().catch(() => [] as Awaited<ReturnType<typeof loadActiveRooms>>),
  ]);

  const disbands: Promise<unknown>[] = [];
  if (savedState) {
    disbands.push(
      api.disbandRoom(server, savedState.controlRoomHash, savedState.participantToken).catch(() => {})
    );
  }
  for (const room of savedRooms) {
    if (!room.participantToken) continue;
    disbands.push(
      api.disbandRoom(server, room.roomHash, room.participantToken).catch(() => {})
    );
  }
  await Promise.all(disbands);

  await Promise.all([clearDaemonState(), clearActiveRooms()]);
  console.log(`Cleared ${savedState ? 1 : 0} control room and ${savedRooms.length} agent room(s).`);
};

export const daemonStop = async (): Promise<void> => {
  const pid = await readPid();
  if (pid === null || !(await isDaemonRunning())) {
    console.log('Daemon is not running.');
    return;
  }

  console.log(`Stopping daemon (PID: ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Process may have already exited
  }

  // Wait for clean shutdown
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!(await isDaemonRunning())) {
      console.log('Daemon stopped.');
      return;
    }
  }

  // Force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone
  }
  await removePid();
  console.log('Daemon force-stopped.');
};

export const daemonStatus = async (): Promise<void> => {
  const pid = await readPid();
  if (pid !== null && await isDaemonRunning()) {
    console.log(`Daemon is running (PID: ${pid}).`);
  } else {
    console.log('Daemon is not running.');
  }
};
