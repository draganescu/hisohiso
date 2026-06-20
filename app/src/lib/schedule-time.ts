// Convert between the user's LOCAL day-of-week + hour picker and the UTC cron
// the daemon stores and executes (#232). The phone authors in local time; the
// daemon runs in UTC.
//
// DST option A (decided): we freeze the UTC wall-clock at create time using the
// current offset. We do NOT track future DST shifts — a job authored as 9am
// local may drift ±1h across a DST boundary. Half-hour / 45-min offset zones
// (India +5:30, Nepal +5:45) are handled correctly because we carry the real
// UTC minute into the cron, not a hardcoded :00.

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A Date at the given LOCAL weekday (0=Sun..6=Sat) and local time, on the soonest
// date >= base that matches the weekday. The recurrence is weekly, so any matching
// week yields the same UTC fields under a fixed offset.
function localDateForWeekday(weekday: number, hourLocal: number, minuteLocal: number, base: Date): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hourLocal, minuteLocal, 0, 0);
  const delta = (weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  return d;
}

function utcDateForWeekday(weekday: number, hourUtc: number, minuteUtc: number, base: Date): Date {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hourUtc, minuteUtc, 0, 0));
  const delta = (weekday - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

// Local day(s)-of-week (0-6) + local hour (0-23) + local minute (0-59) -> stored
// UTC cron "<min> <hour> * * <dow-list>". Returns null on invalid input. The UTC
// minute reflects the local minute plus any half-hour/45-min zone offset.
export function localToUtcCron(localDays: number[], hourLocal: number, minuteLocal = 0, base: Date = new Date()): string | null {
  if (!Array.isArray(localDays) || localDays.length === 0) return null;
  if (!Number.isInteger(hourLocal) || hourLocal < 0 || hourLocal > 23) return null;
  if (!Number.isInteger(minuteLocal) || minuteLocal < 0 || minuteLocal > 59) return null;
  const utcDays = new Set<number>();
  let utcHour: number | null = null;
  let utcMinute = 0;
  for (const wd of localDays) {
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null;
    const dt = localDateForWeekday(wd, hourLocal, minuteLocal, base);
    utcDays.add(dt.getUTCDay());
    utcHour = dt.getUTCHours();
    utcMinute = dt.getUTCMinutes();
  }
  const days = [...utcDays].sort((a, b) => a - b).join(',');
  return `${utcMinute} ${utcHour} * * ${days}`;
}

type LocalSchedule = { days: number[]; hour: number; minute: number };

// Parse a stored UTC cron back into local day(s) + time, for display + edit.
export function utcCronToLocal(cron: string, base: Date = new Date()): LocalSchedule | null {
  const m = cron.trim().match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+([0-6](?:,[0-6])*)$/);
  if (!m) return null;
  const minuteUtc = Number(m[1]);
  const hourUtc = Number(m[2]);
  if (minuteUtc > 59 || hourUtc > 23) return null;
  const utcDays = m[3].split(',').map(Number);
  const localDays = new Set<number>();
  let localHour = hourUtc;
  let localMinute = minuteUtc;
  for (const ud of utcDays) {
    const dt = utcDateForWeekday(ud, hourUtc, minuteUtc, base);
    localDays.add(dt.getDay());
    localHour = dt.getHours();
    localMinute = dt.getMinutes();
  }
  return { days: [...localDays].sort((a, b) => a - b), hour: localHour, minute: localMinute };
}

// "Mon/Wed/Fri 09:00" in the device's local time, from a stored UTC cron.
export function utcCronToLocalLabel(cron: string, base: Date = new Date()): string | null {
  const local = utcCronToLocal(cron, base);
  if (local === null) return null;
  return formatLocal(local.days, local.hour, local.minute);
}

export function formatLocal(days: number[], hour: number, minute: number): string {
  const label = [...days].sort((a, b) => a - b).map((d) => DOW_SHORT[d]).join('/');
  return `${label} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// The hour token the daemon's `schedule add` accepts, in UTC: "7" or "20:30".
export function utcCronToHourToken(cron: string): string | null {
  const m = cron.trim().match(/^(\d+)\s+(\d+)\s+/);
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  return minute === 0 ? String(hour) : `${hour}:${String(minute).padStart(2, '0')}`;
}

// The dow-list token ("1,3,5") the daemon's `schedule add` accepts, from a cron.
export function utcCronToDaysToken(cron: string): string | null {
  const m = cron.trim().match(/^\d+\s+\d+\s+\*\s+\*\s+([0-6](?:,[0-6])*)$/);
  return m ? m[1] : null;
}

export { DOW_SHORT };
