import { fork } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDaemonRunning, readPid, removePid } from '../daemon/pid.js';
import { configExists } from '../lib/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const daemonStart = async (): Promise<void> => {
  if (!(await configExists())) {
    console.error('Not paired yet. Run: hisohiso pair --server <url>');
    process.exit(1);
  }

  if (await isDaemonRunning()) {
    const pid = await readPid();
    console.log(`Daemon is already running (PID: ${pid}).`);
    return;
  }

  console.log('Starting daemon...');

  const daemonScript = join(__dirname, '..', 'daemon', 'daemon-main.js');
  const child = fork(daemonScript, [], {
    detached: true,
    stdio: 'ignore',
    execArgv: [],
  });

  child.unref();

  // Give it a moment to start and write PID
  await new Promise((resolve) => setTimeout(resolve, 1000));

  if (await isDaemonRunning()) {
    const pid = await readPid();
    console.log(`Daemon started (PID: ${pid}).`);
  } else {
    console.error('Daemon failed to start. Check logs.');
    process.exit(1);
  }
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
