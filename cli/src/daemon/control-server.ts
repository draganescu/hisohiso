// Daemon side of the #134 control plane: a Unix-domain socket the detached
// daemon listens on so CLI verbs can reach it. Owner-only (0600), same local
// trust boundary as the PID file. The socket also doubles as the daemon's
// single-instance lock: a Unix socket can have exactly one listener, so a live
// daemon owning it is proof another must not start. A genuinely stale socket
// (crash leftover, no listener) is detected by probe and cleared before bind.

import { createServer, connect, type Server } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { SOCKET_FILE } from '../lib/config.js';
import type { ControlRequest, ControlResponse } from '../lib/control-plane.js';

// Thrown when another daemon is already listening on the control socket, so the
// caller can exit cleanly instead of running as a duplicate.
export class DaemonAlreadyRunningError extends Error {
  constructor() {
    super('Another hisohiso daemon is already listening on the control socket.');
    this.name = 'DaemonAlreadyRunningError';
  }
}

// Probe whether a daemon is already listening on the control socket. A
// successful connect proves a live instance owns it; ECONNREFUSED/ENOENT mean
// the socket file is stale or absent and safe to rebind. This is the real
// single-instance lock — unlike the PID file it can't be silently overwritten
// by a last-writer-wins start, which is how two daemons ended up both serving
// the control room and answering every message twice.
export const isControlSocketLive = (): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = connect(SOCKET_FILE);
    const finish = (live: boolean) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
  });

export type ControlHandlers = {
  status: () => Promise<unknown> | unknown;
  pair: () => Promise<unknown> | unknown;
  admit: (knockMsgId?: string) => Promise<unknown> | unknown;
  deny: (knockMsgId?: string) => Promise<unknown> | unknown;
  repair: () => Promise<unknown> | unknown;
  server: (url: string) => Promise<unknown> | unknown;
  restart: () => Promise<unknown> | unknown;
  notify: (text: string) => Promise<unknown> | unknown;
  scheduleAdd: (a: { days: string; time: string; agent: string; prompt: string; name?: string }) => Promise<unknown> | unknown;
  scheduleList: () => Promise<unknown> | unknown;
  schedulePause: (id: string) => Promise<unknown> | unknown;
  scheduleResume: (id: string) => Promise<unknown> | unknown;
  scheduleRemove: (id: string) => Promise<unknown> | unknown;
  scheduleRun: (id: string) => Promise<unknown> | unknown;
};

export type ControlServerHandle = { close: () => Promise<void> };

// Exported for unit tests: the pure op->handler routing, free of the socket.
export const dispatch = async (h: ControlHandlers, req: ControlRequest): Promise<unknown> => {
  switch (req.op) {
    case 'status':
      return h.status();
    case 'pair':
      return h.pair();
    case 'admit':
      return h.admit(req.knockMsgId);
    case 'deny':
      return h.deny(req.knockMsgId);
    case 'repair':
      return h.repair();
    case 'server':
      return h.server(req.url);
    case 'restart':
      return h.restart();
    case 'notify':
      return h.notify(req.text);
    case 'schedule-add':
      return h.scheduleAdd({ days: req.days, time: req.time, agent: req.agent, prompt: req.prompt, name: req.name });
    case 'schedule-list':
      return h.scheduleList();
    case 'schedule-pause':
      return h.schedulePause(req.id);
    case 'schedule-resume':
      return h.scheduleResume(req.id);
    case 'schedule-remove':
      return h.scheduleRemove(req.id);
    case 'schedule-run':
      return h.scheduleRun(req.id);
    default:
      throw new Error(`unknown control op: ${(req as { op: string }).op}`);
  }
};

export const startControlServer = async (handlers: ControlHandlers): Promise<ControlServerHandle> => {
  // Refuse to start if a daemon is already listening here. The old code
  // unconditionally unlinked the socket, which let a second daemon (e.g. a
  // launchd service started while a foreground one was still alive) stomp the
  // socket and run in parallel — both subscribed to the control room, so every
  // phone message was answered twice (the per-process replay ledger can't dedup
  // across instances). Probe first; only clear a genuinely stale socket.
  if (await isControlSocketLive()) {
    throw new DaemonAlreadyRunningError();
  }
  await unlink(SOCKET_FILE).catch(() => {});

  const server: Server = createServer((sock) => {
    let buf = '';
    sock.on('data', async (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // wait for the full line
      const line = buf.slice(0, nl);
      let resp: ControlResponse;
      try {
        const req = JSON.parse(line) as ControlRequest;
        resp = { ok: true, data: await dispatch(handlers, req) };
      } catch (err) {
        resp = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      sock.write(JSON.stringify(resp) + '\n');
      sock.end();
    });
    // A client that vanishes mid-request must not crash the daemon.
    sock.on('error', () => {});
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      // Lost a race: another daemon bound the socket between our probe and now.
      reject(err.code === 'EADDRINUSE' ? new DaemonAlreadyRunningError() : err);
    };
    server.once('error', onError);
    server.listen(SOCKET_FILE, () => {
      server.off('error', onError);
      resolve();
    });
  });
  await chmod(SOCKET_FILE, 0o600).catch(() => {});

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(SOCKET_FILE).catch(() => {});
    },
  };
};
