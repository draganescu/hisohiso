import { describe, expect, test } from 'bun:test';
import { parseCron, computeNextRunAt, Scheduler, type Schedule } from './scheduler.js';

describe('parseCron', () => {
  test('parses the constrained UTC form', () => {
    expect(parseCron('0 7 * * 1,3,5')).toEqual({ hour: 7, minute: 0, days: new Set([1, 3, 5]) });
  });
  test('rejects anything outside the form', () => {
    expect(parseCron('0 7 5 * 1')).toBeNull(); // dom not *
    expect(parseCron('0 7 * 6 1')).toBeNull(); // month not *
    expect(parseCron('0 24 * * 1')).toBeNull(); // hour out of range
    expect(parseCron('0 7 * * 9')).toBeNull(); // dow out of range
    expect(parseCron('0 7 * *')).toBeNull(); // too few fields
    expect(parseCron('0 7 * * ')).toBeNull(); // empty dow
    expect(parseCron('nonsense')).toBeNull();
  });
});

describe('computeNextRunAt', () => {
  // Anchor: Wed 2026-06-17 12:00:00 UTC (getUTCDay() === 3).
  const wedNoon = Date.UTC(2026, 5, 17, 12, 0, 0);

  test('later hour today', () => {
    const next = computeNextRunAt('0 18 * * 3', wedNoon);
    expect(new Date(next!).toISOString()).toBe('2026-06-17T18:00:00.000Z');
  });
  test('earlier hour today rolls to next matching week', () => {
    const next = computeNextRunAt('0 7 * * 3', wedNoon);
    expect(new Date(next!).toISOString()).toBe('2026-06-24T07:00:00.000Z');
  });
  test('picks the nearest of multiple weekdays', () => {
    const next = computeNextRunAt('0 7 * * 1,3,5', wedNoon); // Fri is nearest future
    expect(new Date(next!).toISOString()).toBe('2026-06-19T07:00:00.000Z');
  });
  test('wraps across the week to Sunday', () => {
    const next = computeNextRunAt('0 9 * * 0', wedNoon);
    expect(new Date(next!).toISOString()).toBe('2026-06-21T09:00:00.000Z');
  });
  test('strictly after: an exact-match instant returns the following week', () => {
    const wed7 = Date.UTC(2026, 5, 17, 7, 0, 0);
    expect(new Date(computeNextRunAt('0 7 * * 3', wed7)!).toISOString()).toBe('2026-06-24T07:00:00.000Z');
  });
  test('null on bad cron', () => {
    expect(computeNextRunAt('bad', wedNoon)).toBeNull();
  });
});

describe('Scheduler', () => {
  const NOW = Date.UTC(2026, 5, 17, 12, 0, 0); // Wed noon
  const makeSched = () => {
    const fired: Schedule[] = [];
    let clock = NOW;
    const s = new Scheduler({
      fire: async (sc) => {
        fired.push(sc);
      },
      persist: () => {},
      now: () => clock,
      maxConcurrent: 2,
    });
    return { s, fired, setClock: (n: number) => { clock = n; } };
  };

  test('add computes nextRunAt, derives a name, assigns an id', () => {
    const { s } = makeSched();
    const sc = s.add({ cron: '0 7 * * 1,3,5', agent: 'claude', prompt: 'hi there' });
    expect(sc).not.toBeNull();
    expect(sc!.id).toMatch(/^sch_/);
    expect(sc!.name).toBe('hi there');
    expect(sc!.nextRunAt).not.toBeNull();
    expect(s.list()).toHaveLength(1);
    s.stop();
  });

  test('add rejects bad cron', () => {
    const { s } = makeSched();
    expect(s.add({ cron: 'bad', agent: 'claude', prompt: 'x' })).toBeNull();
    expect(s.list()).toHaveLength(0);
  });

  test('pause/resume toggles enabled + nextRunAt', () => {
    const { s } = makeSched();
    const sc = s.add({ cron: '0 7 * * 1', agent: 'claude', prompt: 'p' })!;
    expect(s.pause(sc.id)).toBe(true);
    expect(s.get(sc.id)!.enabled).toBe(false);
    expect(s.get(sc.id)!.nextRunAt).toBeNull();
    expect(s.pause(sc.id)).toBe(false); // already paused
    expect(s.resume(sc.id)).toBe(true);
    expect(s.get(sc.id)!.enabled).toBe(true);
    expect(s.get(sc.id)!.nextRunAt).not.toBeNull();
    s.stop();
  });

  test('remove deletes the schedule', () => {
    const { s } = makeSched();
    const sc = s.add({ cron: '0 7 * * 1', agent: 'claude', prompt: 'p' })!;
    expect(s.remove(sc.id)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(s.remove(sc.id)).toBe(false);
  });

  test('runNow fires and records ok', async () => {
    const { s, fired } = makeSched();
    const sc = s.add({ cron: '0 7 * * 1', agent: 'bash', prompt: 'echo-me' })!;
    await s.runNow(sc.id);
    expect(fired.map((f) => f.id)).toContain(sc.id);
    expect(s.get(sc.id)!.lastStatus).toBe('ok');
    expect(s.get(sc.id)!.lastRunAt).not.toBeNull();
    s.stop();
  });

  test('a fire that throws records failed', async () => {
    let clock = NOW;
    const s = new Scheduler({
      fire: async () => { throw new Error('boom'); },
      persist: () => {},
      now: () => clock,
    });
    const sc = s.add({ cron: '0 7 * * 1', agent: 'x', prompt: 'p' })!;
    await s.runNow(sc.id);
    expect(s.get(sc.id)!.lastStatus).toBe('failed');
    s.stop();
  });

  test('load recomputes nextRunAt — a missed occurrence is skipped, not caught up', () => {
    const { s } = makeSched();
    const stale: Schedule = {
      id: 'sch_x', name: 'n', cron: '0 7 * * 1,3,5', agent: 'claude', prompt: 'p',
      mode: 'ephemeral', permissions: 'yolo', enabled: true, catchUp: 'skip',
      timeoutMs: 1000, notifyOnError: true,
      nextRunAt: Date.UTC(2026, 5, 15, 7, 0, 0), // in the past (missed while down)
      lastRunAt: null, lastStatus: null,
    };
    s.load([stale]);
    expect(s.get('sch_x')!.nextRunAt).toBeGreaterThan(NOW); // recomputed to a future fire
    s.stop();
  });
});
