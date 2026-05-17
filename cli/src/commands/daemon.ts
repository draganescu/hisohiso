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
import { runDaemon } from '../daemon/daemon-main.js';

export const daemonStart = async (opts: { fresh?: boolean } = {}): Promise<void> => {
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

  // Runs in foreground: shows QR for phone to join, then enters main loop.
  // Use a process manager (systemd, launchd, screen, tmux) to background it.
  await runDaemon();
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
