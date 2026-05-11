import { isDaemonRunning, readPid, removePid } from '../daemon/pid.js';
import { configExists } from '../lib/config.js';
import { runDaemon } from '../daemon/daemon-main.js';

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

  // Runs in foreground: shows QR for phone to join, then enters main loop.
  // Use a process manager (systemd, launchd, screen, tmux) to background it.
  await runDaemon();
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
