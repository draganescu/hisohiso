// CLI verbs that talk to the running daemon over the #134 control socket:
//   hisohiso status   — what's the daemon doing right now
//   hisohiso pair      — re-render the QR + pairing code for the current room
//   hisohiso admit/deny — resolve a device waiting to join the control room
//
// Each connects, sends one request, renders the reply. When the socket is
// absent we degrade gracefully (status falls back to a PID check; the rest say
// "start the daemon") instead of dumping a connection error.

import qrTerminal from 'qrcode-terminal';
import { isDaemonRunning, readPid } from '../daemon/pid.js';
import { saveConfig } from '../lib/config.js';
import { promptLine } from '../lib/prompt.js';
import {
  sendControlRequest,
  DaemonUnreachableError,
  type StatusResult,
  type PairResult,
  type AdmitResult,
  type ReExecResult,
} from '../lib/control-plane.js';

const confirm = async (prompt: string): Promise<boolean> => {
  const ans = (await promptLine(prompt)).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
};

const fmtUptime = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};

const notRunningHint = 'Daemon is not running — start it with `hisohiso daemon start`.';

export const statusCmd = async (): Promise<void> => {
  try {
    const s = await sendControlRequest<StatusResult>({ op: 'status' });
    console.log(`hisohiso ${s.version} — daemon running, up ${fmtUptime(s.uptimeMs)}`);
    console.log(
      `control room ${s.controlRoomHash.slice(0, 12)}… · ${s.paired ? 'paired' : 'awaiting pairing — run `hisohiso pair`'}`
    );
    if (s.agents.length === 0) {
      console.log('agents: none running');
    } else {
      console.log(`agents (${s.agents.length}):`);
      for (const a of s.agents) console.log(`  ${a.name.padEnd(12)} ${a.agentId}`);
    }
    if (s.pendingDevices.length > 0) {
      console.log(
        `\n${s.pendingDevices.length} device(s) awaiting admission — run \`hisohiso admit\` to let them in.`
      );
    }
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      // Socket gone: answer the PID-level question truthfully instead of failing.
      const pid = await readPid();
      if (pid !== null && (await isDaemonRunning())) {
        console.log(`Daemon process is running (PID ${pid}) but the control socket is unavailable.`);
      } else {
        console.log('Daemon is not running.');
      }
      return;
    }
    console.error(`status failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

export const pairCmd = async (): Promise<void> => {
  try {
    const p = await sendControlRequest<PairResult>({ op: 'pair' });
    console.log('\nScan to connect a phone to the daemon:\n');
    qrTerminal.generate(p.joinUrl, { small: true }, (code: string) => console.log(code));
    console.log(`\nOr open: ${p.joinUrl}`);
    console.log(`Pairing code: ${p.pairingCode}`);
    console.log('(Use your session knock message as the knock body — it is never shown here.)');
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      console.log(notRunningHint);
      return;
    }
    console.error(`pair failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

const resolveDevice = async (op: 'admit' | 'deny', knockMsgId?: string): Promise<void> => {
  try {
    const r = await sendControlRequest<AdmitResult>({ op, knockMsgId });
    console.log(r.message);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      console.log(notRunningHint);
      return;
    }
    console.error(`${op} failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

export const admitCmd = async (knockMsgId?: string): Promise<void> => resolveDevice('admit', knockMsgId);
export const denyCmd = async (knockMsgId?: string): Promise<void> => resolveDevice('deny', knockMsgId);

// Non-destructive in-place re-exec: pairing and agent rooms survive. The only
// way to bounce a backgrounded (launchd/systemd) daemon without poking the
// service manager — `stop` alone leaves it to the service's restart throttle,
// and `start` in a terminal lands you a foreground daemon you didn't want.
export const restartCmd = async (): Promise<void> => {
  try {
    const r = await sendControlRequest<ReExecResult>({ op: 'restart' });
    console.log(r.message);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      console.log(notRunningHint);
      return;
    }
    console.error(`restart failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

// Destructive (#134 pt2): disband ALL rooms and re-pair from scratch. The daemon
// re-execs ~0.5s after replying.
export const repairCmd = async (opts: { yes?: boolean } = {}): Promise<void> => {
  if (!opts.yes && !(await confirm('Disband ALL rooms and re-pair from scratch? This kills every running agent. [y/N] '))) {
    console.log('Aborted.');
    return;
  }
  try {
    const r = await sendControlRequest<ReExecResult>({ op: 'repair' });
    console.log(r.message);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      console.log(notRunningHint);
      return;
    }
    console.error(`repair failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};

// `server <url>`: if a daemon is live, this is a destructive migration (disband
// on the old host + re-exec on the new one). If no daemon is running, it falls
// back to the original behaviour — just record the server for the next start.
export const serverCmd = async (url: string, opts: { yes?: boolean } = {}): Promise<void> => {
  let running = false;
  try {
    await sendControlRequest<StatusResult>({ op: 'status' }, 1500);
    running = true;
  } catch (err) {
    if (!(err instanceof DaemonUnreachableError)) {
      console.error(`server failed: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!running) {
    await saveConfig({ server: url });
    console.log(`Server set to ${url}. (No daemon running — applied to config; takes effect on next \`hisohiso daemon start\`.)`);
    return;
  }

  if (!opts.yes && !(await confirm(`Move the running daemon to ${url}? This disbands all rooms on the current server. [y/N] `))) {
    console.log('Aborted.');
    return;
  }
  try {
    const r = await sendControlRequest<ReExecResult>({ op: 'server', url });
    console.log(r.message);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) {
      // Raced: the daemon went away between probe and migrate — record it anyway.
      await saveConfig({ server: url });
      console.log(`Server set to ${url}. (Daemon stopped — applied to config.)`);
      return;
    }
    console.error(`server failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
};
