import { spawn } from 'node:child_process';
import { isDaemonRunning, readPid, removePid } from '../daemon/pid.js';
import { configExists } from '../lib/config.js';

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

  // Re-invoke ourselves with a hidden subcommand.
  // Works for both `npx tsx src/index.ts` and compiled binary.
  const execPath = process.argv[0]!;
  const execArgs = process.argv.slice(1);

  // Find where "daemon" "start" appears in argv and replace with "daemon" "_run"
  const daemonIdx = execArgs.indexOf('daemon');
  const runArgs = daemonIdx >= 0
    ? [...execArgs.slice(0, daemonIdx), 'daemon', '_run']
    : [...execArgs.slice(0, -1), 'daemon', '_run'];

  const child = spawn(execPath, runArgs, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  // Give it a moment to start and write PID
  await new Promise((resolve) => setTimeout(resolve, 1500));

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
