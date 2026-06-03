// Daemon side of the #134 control plane: a Unix-domain socket the detached
// daemon listens on so CLI verbs can reach it. Owner-only (0600), same local
// trust boundary as the PID file. Stale socket from a crash is unlinked on
// start (mirrors the stale-PID cleanup in pid.ts).

import { createServer, type Server } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { SOCKET_FILE } from '../lib/config.js';
import type { ControlRequest, ControlResponse } from '../lib/control-plane.js';

export type ControlHandlers = {
  status: () => Promise<unknown> | unknown;
  pair: () => Promise<unknown> | unknown;
  admit: (knockMsgId?: string) => Promise<unknown> | unknown;
  deny: (knockMsgId?: string) => Promise<unknown> | unknown;
};

export type ControlServerHandle = { close: () => Promise<void> };

const dispatch = async (h: ControlHandlers, req: ControlRequest): Promise<unknown> => {
  switch (req.op) {
    case 'status':
      return h.status();
    case 'pair':
      return h.pair();
    case 'admit':
      return h.admit(req.knockMsgId);
    case 'deny':
      return h.deny(req.knockMsgId);
    default:
      throw new Error(`unknown control op: ${(req as { op: string }).op}`);
  }
};

export const startControlServer = async (handlers: ControlHandlers): Promise<ControlServerHandle> => {
  // Unlink a stale socket from a previous crash; bind() fails on EADDRINUSE
  // otherwise. (A live daemon already holds the PID lock, so we never race a
  // second real instance here.)
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
    server.once('error', reject);
    server.listen(SOCKET_FILE, () => {
      server.off('error', reject);
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
