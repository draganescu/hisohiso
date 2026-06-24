// Daemon-owned scheduler (#232). The always-on daemon holds recurring schedules
// and fires them itself — no system cron needed for agent work. v1 is ephemeral
// only: a fire runs an agent headless and posts a summary to the control room.
//
// Schedule shape (decided in design):
//   • when = day(s) of week + hour, NO minutes (top of the hour), recurring weekly
//   • cron is stored + evaluated in UTC (the phone converts local→UTC on create,
//     freezing the UTC wall-clock — DST option A, accepts ±1h local drift)
//   • missed runs (daemon was down) are SKIPPED, never caught up
//
// This module is deliberately free of daemon/agent coupling: the fire action and
// persistence are injected, and `now` is injectable, so the next-fire math and
// lifecycle are unit-testable without timers, rooms, or a clock.

export type ScheduleStatus = 'ok' | 'failed' | 'timed-out' | 'skipped' | null;

export type Schedule = {
  id: string;
  name: string;
  // Canonical UTC cron, constrained to "<min> <hour> * * <dow-list>" where min is
  // always 0 and dow uses cron 0-6 (0 = Sunday), matching Date#getUTCDay().
  cron: string;
  agent: string;
  prompt: string;
  mode: 'ephemeral';
  permissions: 'yolo';
  enabled: boolean;
  catchUp: 'skip';
  timeoutMs: number;
  notifyOnError: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: ScheduleStatus;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — bound a runaway scheduled agent

// Parse the constrained cron form into an hour + a set of weekdays (0-6). Returns
// null on anything outside the form we author, so a malformed entry never arms a
// timer (it just never fires, rather than firing wrong).
export function parseCron(cron: string): { hour: number; minute: number; days: Set<number> } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return null;
  const minute = Number(m);
  const hour = Number(h);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const days = new Set<number>();
  for (const tok of dow.split(',')) {
    const d = Number(tok);
    if (!Number.isInteger(d) || d < 0 || d > 6) return null;
    days.add(d);
  }
  if (days.size === 0) return null;
  return { hour, minute, days };
}

const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Parse a days token into a normalized cron dow list (0-6, 0=Sun). Accepts
// digits ("1,3,5"), names ("mon,wed,fri"), or the shortcuts "weekdays"/"daily".
// Returns null on anything unrecognized so a bad schedule is rejected, not
// silently mis-scheduled. Shared by the control room and the CLI so both agree.
export function parseDaysToken(tok: string): string | null {
  const out = new Set<number>();
  for (const part of tok.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (part === 'weekdays') { [1, 2, 3, 4, 5].forEach((x) => out.add(x)); continue; }
    if (part === 'daily' || part === 'everyday' || part === '*') { [0, 1, 2, 3, 4, 5, 6].forEach((x) => out.add(x)); continue; }
    if (/^[0-6]$/.test(part)) { out.add(Number(part)); continue; }
    if (part in DOW_NAMES) { out.add(DOW_NAMES[part]!); continue; }
    return null;
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => a - b).join(',');
}

// Build a stored UTC cron from a friendly days token + a UTC time token ("H" or
// "H:MM"). Returns { cron } or { error } so callers can surface a usage hint.
// The single source of truth for the control room AND the `hisohiso schedule`
// CLI, so the two can never drift.
export function buildCronFromArgs(days: string, time: string): { cron: string } | { error: string } {
  const dow = parseDaysToken(days ?? '');
  if (!dow) return { error: 'days must be mon,wed,fri | weekdays | daily | 0-6 (0=Sun)' };
  const m = (time ?? '').match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  const hour = m ? Number(m[1]) : NaN;
  const minute = m && m[2] !== undefined ? Number(m[2]) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { error: 'time must be 0-23 UTC, or H:MM (e.g. 20:30)' };
  }
  return { cron: `${minute} ${hour} * * ${dow}` };
}

// Next UTC instant strictly after `fromMs` that matches the cron's hour + weekday
// set. Scans up to 8 days (a full week + 1) so it always lands on a match if the
// cron is valid. Returns null for an unparseable cron.
export function computeNextRunAt(cron: string, fromMs: number): number | null {
  const spec = parseCron(cron);
  if (spec === null) return null;
  const from = new Date(fromMs);
  for (let i = 0; i <= 8; i += 1) {
    const candidate = Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate() + i,
      spec.hour,
      spec.minute,
      0,
      0,
    );
    if (candidate > fromMs && spec.days.has(new Date(candidate).getUTCDay())) {
      return candidate;
    }
  }
  return null;
}

export type FireFn = (schedule: Schedule) => Promise<void>;
export type PersistFn = (schedules: Schedule[]) => Promise<void> | void;

export type SchedulerOpts = {
  fire: FireFn;
  persist: PersistFn;
  now?: () => number;
  log?: (msg: string) => void;
  // Cap on concurrent scheduled runs so a burst can't fork-bomb token spend.
  maxConcurrent?: number;
};

export type NewScheduleInput = {
  cron: string;
  agent: string;
  prompt: string;
  name?: string;
  timeoutMs?: number;
  notifyOnError?: boolean;
};

// Derive a short human label from the prompt when the user didn't name the job.
const deriveName = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  return compact.length > 32 ? `${compact.slice(0, 29)}…` : compact || 'schedule';
};

export class Scheduler {
  private schedules: Schedule[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private readonly fire: FireFn;
  private readonly persist: PersistFn;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly maxConcurrent: number;
  private seq = 0;

  constructor(opts: SchedulerOpts) {
    this.fire = opts.fire;
    this.persist = opts.persist;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.maxConcurrent = opts.maxConcurrent ?? 2;
  }

  // Adopt persisted schedules and arm timers. Missed occurrences are skipped:
  // nextRunAt is recomputed from now, so a daemon that was down over a fire time
  // simply schedules the next future one (catchUp = 'skip').
  load(schedules: Schedule[]): void {
    this.stop();
    this.schedules = schedules.map((s) => ({ ...s }));
    for (const s of this.schedules) {
      if (s.enabled) this.arm(s);
    }
  }

  list(): Schedule[] {
    return this.schedules.map((s) => ({ ...s }));
  }

  get(id: string): Schedule | undefined {
    const s = this.schedules.find((x) => x.id === id);
    return s ? { ...s } : undefined;
  }

  add(input: NewScheduleInput): Schedule | null {
    if (parseCron(input.cron) === null) return null;
    const id = `sch_${(++this.seq).toString(36)}${(this.now() % 1000).toString(36)}`;
    const schedule: Schedule = {
      id,
      name: input.name?.trim() || deriveName(input.prompt),
      cron: input.cron,
      agent: input.agent,
      prompt: input.prompt,
      mode: 'ephemeral',
      permissions: 'yolo',
      enabled: true,
      catchUp: 'skip',
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      notifyOnError: input.notifyOnError ?? true,
      nextRunAt: computeNextRunAt(input.cron, this.now()),
      lastRunAt: null,
      lastStatus: null,
    };
    this.schedules.push(schedule);
    this.arm(schedule);
    void this.persist(this.schedules);
    return { ...schedule };
  }

  pause(id: string): boolean {
    const s = this.schedules.find((x) => x.id === id);
    if (!s || !s.enabled) return false;
    s.enabled = false;
    s.nextRunAt = null;
    this.disarm(id);
    void this.persist(this.schedules);
    return true;
  }

  resume(id: string): boolean {
    const s = this.schedules.find((x) => x.id === id);
    if (!s || s.enabled) return false;
    s.enabled = true;
    this.arm(s);
    void this.persist(this.schedules);
    return true;
  }

  remove(id: string): boolean {
    const idx = this.schedules.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    this.disarm(id);
    this.schedules.splice(idx, 1);
    void this.persist(this.schedules);
    return true;
  }

  // Fire a schedule immediately (the "Run now" control). Bypasses enabled/timer
  // but still honors the overlap + concurrency guards.
  async runNow(id: string): Promise<void> {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return;
    await this.fireGuarded(s);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  private arm(schedule: Schedule): void {
    this.disarm(schedule.id);
    const next = computeNextRunAt(schedule.cron, this.now());
    schedule.nextRunAt = next;
    if (next === null) {
      this.log(`schedule ${schedule.id} has no valid next run; not armed`);
      return;
    }
    // setTimeout caps at ~24.8 days; our horizon is <= 7 days so a single timer
    // is always enough. Clamp to 0 in case the computed instant just passed.
    const delay = Math.max(0, next - this.now());
    const timer = setTimeout(() => {
      void this.fireGuarded(schedule).finally(() => {
        // Re-arm for the following week's occurrence.
        if (schedule.enabled) this.arm(schedule);
      });
    }, delay);
    // unref so an armed schedule never by itself keeps the process alive (the
    // daemon stays up for SSE/the control socket anyway); also keeps tests clean.
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(schedule.id, timer);
  }

  private async fireGuarded(schedule: Schedule): Promise<void> {
    if (this.running.has(schedule.id)) {
      this.log(`schedule ${schedule.id} still running from a previous fire; skipping`);
      return;
    }
    if (this.running.size >= this.maxConcurrent) {
      this.log(`max concurrent scheduled runs (${this.maxConcurrent}) reached; skipping ${schedule.id}`);
      return;
    }
    this.running.add(schedule.id);
    schedule.lastRunAt = this.now();
    try {
      await this.fire(schedule);
      schedule.lastStatus = 'ok';
    } catch (err) {
      schedule.lastStatus = err instanceof TimeoutError ? 'timed-out' : 'failed';
      this.log(`schedule ${schedule.id} fire failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running.delete(schedule.id);
      void this.persist(this.schedules);
    }
  }
}

export class TimeoutError extends Error {
  constructor(message = 'timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}
