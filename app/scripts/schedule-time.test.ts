import {
  localToUtcCron,
  utcCronToLocal,
  utcCronToLocalLabel,
  utcCronToHourToken,
  utcCronToDaysToken,
  formatLocal,
} from '../src/lib/schedule-time.js';

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

// Round-trip invariant (tz-agnostic): local days + hour -> UTC cron -> back to
// the SAME local days + hour. Runs under whatever TZ the test process uses, so
// it catches offset/day-shift bugs without hardcoding any zone.
for (const hour of [0, 7, 13, 23]) {
  for (const days of [[1], [0, 6], [1, 3, 5], [0, 1, 2, 3, 4, 5, 6]]) {
    const cron = localToUtcCron(days, hour);
    assert(cron !== null, `cron should build for ${JSON.stringify(days)}@${hour}`);
    const back = utcCronToLocal(cron!);
    assert(back !== null, `roundtrip should parse ${cron}`);
    assert(back!.hour === hour, `hour roundtrip ${cron} -> ${back!.hour}, expected ${hour}`);
    assert(back!.minute === 0, `local minute should be 0 for ${cron}`);
    assert(
      JSON.stringify([...back!.days].sort((a, b) => a - b)) === JSON.stringify([...days].sort((a, b) => a - b)),
      `days roundtrip ${cron}: got ${JSON.stringify(back!.days)} vs ${JSON.stringify(days)}`,
    );
  }
}

// Label round-trips to the local picker label.
{
  const cron = localToUtcCron([1, 3, 5], 9)!;
  assert(
    utcCronToLocalLabel(cron) === formatLocal([1, 3, 5], 9, 0),
    `label roundtrip mismatch: ${utcCronToLocalLabel(cron)}`,
  );
}

// Command tokens the daemon's `schedule add` consumes.
assert(utcCronToHourToken('0 7 * * 1') === '7', 'hour token for whole hour');
assert(utcCronToHourToken('30 20 * * 0') === '20:30', 'hour token carries minutes');
assert(utcCronToDaysToken('0 7 * * 1,3,5') === '1,3,5', 'days token');
assert(utcCronToHourToken('bad') === null, 'bad cron -> null hour token');

// Validation.
assert(localToUtcCron([], 9) === null, 'empty days should be rejected');
assert(localToUtcCron([1], 24) === null, 'hour 24 should be rejected');
assert(localToUtcCron([7], 9) === null, 'weekday 7 should be rejected');
assert(utcCronToLocal('bad') === null, 'bad cron should be rejected');
assert(utcCronToLocal('0 7 5 * 1') === null, 'cron with day-of-month should be rejected');

// Half-hour offset correctness: only assert when actually running under a +5:30
// zone, so the test stays tz-agnostic everywhere else.
{
  const offsetMin = -new Date(2026, 0, 15).getTimezoneOffset();
  if (offsetMin === 330) {
    const cron = localToUtcCron([1], 2)!; // Mon 02:00 IST -> Sun 20:30 UTC
    assert(cron === '30 20 * * 0', `Kolkata Mon 02:00 should map to "30 20 * * 0", got ${cron}`);
    assert(utcCronToHourToken(cron) === '20:30', 'Kolkata hour token should be 20:30');
  }
}

console.log('schedule-time: all assertions passed');
