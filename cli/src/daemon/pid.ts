import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { PID_FILE } from '../lib/config.js';

export const writePid = async (pid: number): Promise<void> => {
  await writeFile(PID_FILE, String(pid) + '\n', 'utf-8');
};

export const readPid = async (): Promise<number | null> => {
  try {
    const raw = await readFile(PID_FILE, 'utf-8');
    const pid = parseInt(raw.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
};

export const removePid = async (): Promise<void> => {
  try {
    await unlink(PID_FILE);
  } catch {
    // Already gone
  }
};

// Full argv of a live PID, or null if we can't read it. `ps` is the portable
// route on both macOS and Linux; /proc doesn't exist on Darwin.
const commandOf = (pid: number): Promise<string | null> =>
  new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });

// Does this PID look like our daemon? After a reboot the kernel hands out low
// PIDs again, so a stale PID file routinely points at an unrelated system
// process (SidecarRelay, etc). `kill(pid, 0)` says "alive" and `daemon start`
// then refuses to start forever — with KeepAlive that's a 10s respawn loop that
// never comes up. Match on argv so a recycled PID reads as stale, not as us.
const isOurDaemon = async (pid: number): Promise<boolean> => {
  const cmd = await commandOf(pid);
  // Unreadable argv (permissions, ps missing): fall back to trusting the PID
  // rather than killing a daemon that really is running.
  if (cmd === null) return true;
  return /hisohiso/.test(cmd);
};

export const isDaemonRunning = async (): Promise<boolean> => {
  const pid = await readPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
  } catch {
    // Process doesn't exist; clean up stale PID file
    await removePid();
    return false;
  }
  if (!(await isOurDaemon(pid))) {
    // PID was recycled by an unrelated process — the file is stale.
    await removePid();
    return false;
  }
  return true;
};
