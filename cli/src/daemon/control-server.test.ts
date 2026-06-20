import { describe, expect, test } from 'bun:test';
import { dispatch, type ControlHandlers } from './control-server.js';
import type { ControlRequest } from '../lib/control-plane.js';

// Build a full set of stub handlers that record their args, so a routing test
// can assert which handler a given op reached (and with what payload) without
// standing up the Unix socket.
const makeHandlers = (
  over: Partial<ControlHandlers> = {}
): { handlers: ControlHandlers; calls: Record<string, unknown[]> } => {
  const calls: Record<string, unknown[]> = {};
  const rec =
    (name: string, ret: unknown) =>
    (...args: unknown[]): unknown => {
      calls[name] = args;
      return ret;
    };
  const handlers: ControlHandlers = {
    status: rec('status', { ok: 'status' }),
    pair: rec('pair', { ok: 'pair' }),
    admit: rec('admit', { ok: 'admit' }),
    deny: rec('deny', { ok: 'deny' }),
    repair: rec('repair', { ok: 'repair' }),
    server: rec('server', { ok: 'server' }),
    restart: rec('restart', { ok: 'restart' }),
    notify: rec('notify', { delivered: true, message: 'Posted to the control room.' }),
    ...over,
  };
  return { handlers, calls };
};

describe('control-server dispatch', () => {
  test('routes notify to the notify handler with the message text', async () => {
    const { handlers, calls } = makeHandlers();
    const res = await dispatch(handlers, { op: 'notify', text: 'caddy is down' } as ControlRequest);
    expect(calls.notify).toEqual(['caddy is down']);
    expect(res).toEqual({ delivered: true, message: 'Posted to the control room.' });
  });

  test('awaits an async notify handler and returns its result', async () => {
    const { handlers } = makeHandlers({
      notify: async (text: string) => ({ delivered: true, message: `got: ${text}` }),
    });
    const res = await dispatch(handlers, { op: 'notify', text: 'hi' } as ControlRequest);
    expect(res).toEqual({ delivered: true, message: 'got: hi' });
  });

  test('throws on an unknown op', async () => {
    const { handlers } = makeHandlers();
    await expect(
      dispatch(handlers, { op: 'bogus' } as unknown as ControlRequest)
    ).rejects.toThrow(/unknown control op/);
  });
});
