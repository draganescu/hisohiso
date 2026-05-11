import { readFile, writeFile, unlink } from 'node:fs/promises';
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

export const isDaemonRunning = async (): Promise<boolean> => {
  const pid = await readPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist; clean up stale PID file
    await removePid();
    return false;
  }
};
