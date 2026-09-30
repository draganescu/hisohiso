import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The single-instance lock, against a real Unix socket. Runs in a child
// process with its own HISOHISO_HOME: config.ts reads it at import time, and
// this must never touch the operator's ~/.hisohiso socket.
const runInIsolatedHome = (body: string): { code: number; out: string } => {
  const home = mkdtempSync(join(tmpdir(), 'hisohiso-lock-'));
  const script = `
    import { startControlServer, DaemonAlreadyRunningError, isControlSocketLive } from ${JSON.stringify(join(import.meta.dir, 'control-server.ts'))};
    const handlers = new Proxy({}, { get: () => () => ({}) });
    ${body}
    process.exit(0);
  `;
  const res = Bun.spawnSync(['bun', '-e', script], { env: { ...process.env, HISOHISO_HOME: home } });
  return { code: res.exitCode ?? -1, out: res.stdout.toString() + res.stderr.toString() };
};

describe('control socket single-instance lock', () => {
  test('a second daemon binding the socket gets DaemonAlreadyRunningError, not a plain bind error', () => {
    const { code, out } = runInIsolatedHome(`
      const first = await startControlServer(handlers);
      try {
        await startControlServer(handlers);
        console.log('SECOND-STARTED');
      } catch (err) {
        console.log(err instanceof DaemonAlreadyRunningError ? 'ALREADY-RUNNING' : 'OTHER:' + err.message);
      }
      await first.close();
    `);
    expect(out).toContain('ALREADY-RUNNING');
    expect(code).toBe(0);
  });

  test("closing a predecessor does not remove its successor's socket", () => {
    const { code, out } = runInIsolatedHome(`
      const { unlink } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const old = await startControlServer(handlers);
      // The successor takes over the path while the predecessor is still up
      // (a re-exec handoff), then the predecessor shuts down.
      await unlink(join(process.env.HISOHISO_HOME, 'daemon.sock'));
      const next = await startControlServer(handlers);
      await old.close();
      console.log((await isControlSocketLive()) ? 'SUCCESSOR-LIVE' : 'SUCCESSOR-GONE');
      await next.close();
      console.log((await isControlSocketLive()) ? 'STILL-LIVE' : 'RELEASED');
    `);
    expect(out).toContain('SUCCESSOR-LIVE');
    expect(out).toContain('RELEASED');
    expect(code).toBe(0);
  });
});
