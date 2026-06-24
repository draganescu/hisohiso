// Control-plane wire protocol shared by the daemon (server) and the CLI verbs
// (client) — #134. One JSON request per connection, one JSON response, newline
// terminated, over the owner-only Unix socket at ~/.hisohiso/daemon.sock.
//
// This is the only channel to a backgrounded daemon: once detached it has no
// TTY, so `status` / `pair` / `admit` / `deny` reach it here instead.
//
// (Distinct from the older lib/control-protocol.ts, which is the in-band
// agent-room message envelope used by room-bridge — unrelated to this socket.)

import { connect } from 'node:net';
import { SOCKET_FILE } from './config.js';
import type { Schedule } from './scheduler.js';

export type ControlRequest =
  | { op: 'status' }
  | { op: 'pair' }
  | { op: 'admit'; knockMsgId?: string }
  | { op: 'deny'; knockMsgId?: string }
  // Destructive (#134 pt2): both tear down rooms server-side then re-exec.
  | { op: 'repair' }
  | { op: 'server'; url: string }
  // Non-destructive in-place re-exec: rooms and pairing preserved. Used by
  // `daemon restart` and by `update` to move a backgrounded daemon onto a
  // freshly-swapped binary without any launchd/systemd interaction.
  | { op: 'restart' }
  // Post a one-off message into the live control room. The host's channel for
  // local automation (cron, health checks, deploy hooks) to ping the operator's
  // phone — the daemon encrypts and sends it like any other control-room reply.
  | { op: 'notify'; text: string }
  // Scheduler ops — the `hisohiso schedule` CLI drives the same daemon Scheduler
  // the control room uses, so an agent with shell access can self-schedule.
  // days/time are friendly + UTC ("weekdays", "9" or "9:30"); the daemon builds
  // the cron via the shared buildCronFromArgs helper.
  | { op: 'schedule-add'; days: string; time: string; agent: string; prompt: string; name?: string }
  | { op: 'schedule-list' }
  | { op: 'schedule-pause'; id: string }
  | { op: 'schedule-resume'; id: string }
  | { op: 'schedule-remove'; id: string }
  | { op: 'schedule-run'; id: string };

export type AgentSummary = { agentId: string; name: string };
export type PendingDevice = { knockMsgId: string; expiresAt: number };

export type StatusResult = {
  version: string;
  uptimeMs: number;
  controlRoomHash: string;
  // controlBound: a first device has paired. false => awaiting-pairing.
  paired: boolean;
  agents: AgentSummary[];
  pendingDevices: PendingDevice[];
};

// The knock SECRET (sessionKnockMessage) is deliberately NOT in this result —
// the knock gate depends on it staying off-screen. `pair` re-renders only the
// material a phone needs: room_secret (in the URL fragment) + pairing code.
export type PairResult = {
  joinUrl: string;
  pairingCode: string;
  controlRoomHash: string;
};

export type AdmitResult = { resolved: number; message: string };

// `notify` confirms the message reached the control room. `delivered` is false
// only when the control room is not ready yet (early boot / mid re-pair); the
// message text is human-readable for the CLI to print.
export type NotifyResult = { delivered: boolean; message: string };

// Scheduler op results. `schedule-add` returns the created schedule; `-list`
// the full set; the mutating ops a boolean + human message the CLI prints.
export type ScheduleAddResult = { schedule: Schedule };
export type ScheduleListResult = { schedules: Schedule[] };
export type ScheduleActionResult = { ok: boolean; message: string };

// repair / server return a human-readable confirmation; the daemon re-execs
// ~half a second later, so the reply is sent before the process recycles.
export type ReExecResult = { message: string };

export type ControlResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// Distinct error so callers can fall back gracefully (e.g. `status` drops to a
// PID-only check) instead of printing a stack when no daemon is up.
export class DaemonUnreachableError extends Error {
  constructor(message = 'daemon control socket not available') {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

export const sendControlRequest = async <T = unknown>(
  req: ControlRequest,
  timeoutMs = 5000
): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const sock = connect(SOCKET_FILE);
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('control socket timed out'))),
      timeoutMs
    );
    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let resp: ControlResponse<T>;
      try {
        resp = JSON.parse(buf.slice(0, nl)) as ControlResponse<T>;
      } catch {
        finish(() => reject(new Error('malformed control response')));
        return;
      }
      finish(() => (resp.ok ? resolve(resp.data) : reject(new Error(resp.error))));
    });
    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        finish(() => reject(new DaemonUnreachableError()));
      } else {
        finish(() => reject(err));
      }
    });
  });
};
