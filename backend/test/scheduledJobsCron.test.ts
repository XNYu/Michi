import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CronParseError,
  isValidTimeZone,
  nextCronRun,
  parseCron,
  wallClockInstants,
} from '../src/services/scheduledJobs/cron';
import { computeNextRun, parseSchedule, previewSchedule, ScheduleValidationError } from '../src/services/scheduledJobs/schedule';

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
const at = (text: string) => Date.parse(text);
const next = (expression: string, after: string, timeZone = 'UTC') => iso(nextCronRun(parseCron(expression), at(after), timeZone));

describe('parseCron', () => {
  test('parses lists, ranges, steps, names and Sunday as 7', () => {
    const spec = parseCron('0,30 9-17/4 1 JAN-mar sun,7');
    assert.deepEqual(spec.minutes, [0, 30]);
    assert.deepEqual(spec.hours, [9, 13, 17]);
    assert.deepEqual([...spec.months].sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual([...spec.daysOfWeek], [0]);
    assert.equal(spec.domRestricted, true);
    assert.equal(spec.dowRestricted, true);
    assert.equal(spec.repeatsInOverlap, false);
  });

  test('a single value with a step runs to the end of the range', () => {
    assert.deepEqual(parseCron('10/20 * * * *').minutes, [10, 30, 50]);
  });

  test('expands macros', () => {
    assert.deepEqual(parseCron('@daily').hours, [0]);
    assert.deepEqual(parseCron('@hourly').minutes, [0]);
    assert.equal(parseCron('@hourly').repeatsInOverlap, true);
  });

  test('rejects malformed expressions with a readable reason', () => {
    for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', '* * * * MON-', '@reboot', 'a b c d e']) {
      assert.throws(() => parseCron(bad), CronParseError, bad);
    }
  });
});

describe('nextCronRun', () => {
  test('finds the next step boundary strictly after the cursor', () => {
    assert.equal(next('*/15 * * * *', '2026-01-01T00:07:30Z'), '2026-01-01T00:15:00.000Z');
    assert.equal(next('*/15 * * * *', '2026-01-01T00:15:00Z'), '2026-01-01T00:30:00.000Z');
  });

  test('weekday schedules skip the weekend in the schedule timezone', () => {
    // Friday 10:00 EDT -> Monday 09:00 EDT.
    assert.equal(next('0 9 * * 1-5', '2026-10-16T14:00:00Z', 'America/New_York'), '2026-10-19T13:00:00.000Z');
  });

  test('day-of-month and day-of-week match with OR when both are restricted', () => {
    // 2026-02-01 is a Sunday; the 15th is a Sunday too, the 2nd a Monday.
    assert.equal(next('0 0 15 * MON', '2026-02-01T12:00:00Z'), '2026-02-02T00:00:00.000Z');
    assert.equal(next('0 0 15 * *', '2026-02-01T12:00:00Z'), '2026-02-15T00:00:00.000Z');
  });

  test('a nonexistent spring-forward time runs at the shifted instant', () => {
    // New York skips 02:00-03:00 on 2026-03-08; 02:30 becomes 03:30 EDT.
    assert.equal(next('30 2 * * *', '2026-03-07T12:00:00Z', 'America/New_York'), '2026-03-08T07:30:00.000Z');
    assert.equal(next('30 2 * * *', '2026-03-08T07:30:00Z', 'America/New_York'), '2026-03-09T06:30:00.000Z');
  });

  test('a fixed time in a repeated fall-back hour runs once', () => {
    // 01:30 happens at 05:30Z (EDT) and 06:30Z (EST) on 2026-11-01.
    assert.equal(next('30 1 * * *', '2026-10-31T12:00:00Z', 'America/New_York'), '2026-11-01T05:30:00.000Z');
    assert.equal(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York'), '2026-11-02T06:30:00.000Z');
  });

  test('wildcard schedules keep running through a repeated hour', () => {
    // Berlin repeats 02:00-02:59 on 2026-10-25 (00:00Z-00:59Z CEST, 01:00Z-01:59Z CET).
    assert.equal(next('* * * * *', '2026-10-25T00:59:30Z', 'Europe/Berlin'), '2026-10-25T01:00:00.000Z');
    assert.equal(next('0 * * * *', '2026-10-25T00:00:00Z', 'Europe/Berlin'), '2026-10-25T01:00:00.000Z');
  });

  test('reports schedules that can never run', () => {
    assert.equal(next('0 0 30 2 *', '2026-01-01T00:00:00Z'), null);
  });

  test('finds leap days years ahead', () => {
    assert.equal(next('0 12 29 2 *', '2026-03-01T00:00:00Z'), '2028-02-29T12:00:00.000Z');
  });

  test('wallClockInstants lists both instants of a repeated time', () => {
    assert.deepEqual(
      wallClockInstants(2026, 11, 1, 1, 30, 'America/New_York').map((value) => new Date(value).toISOString()),
      ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
    );
  });
});

describe('schedule helpers', () => {
  const now = at('2026-10-16T12:00:00Z');

  test('validates timezones', () => {
    assert.equal(isValidTimeZone('Asia/Tokyo'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
  });

  test('parseSchedule normalizes and validates each kind', () => {
    assert.deepEqual(parseSchedule({ kind: 'every', everySeconds: 3600 }, now), { kind: 'every', everySeconds: 3600 });
    assert.deepEqual(parseSchedule({ kind: 'cron', expression: ' 0  9 * * * ', timezone: 'Asia/Tokyo' }, now),
      { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo' });
    assert.deepEqual(parseSchedule({ kind: 'cron', expression: '0 9 * * *', timezone: '' }, now),
      { kind: 'cron', expression: '0 9 * * *', timezone: null });
    assert.throws(() => parseSchedule({ kind: 'every', everySeconds: 30 }, now), ScheduleValidationError);
    assert.throws(() => parseSchedule({ kind: 'every', everySeconds: 90.5 }, now), ScheduleValidationError);
    assert.throws(() => parseSchedule({ kind: 'cron', expression: '0 9 * * *', timezone: 'Nope/Zone' }, now), ScheduleValidationError);
    assert.throws(() => parseSchedule({ kind: 'cron', expression: '0 0 31 2 *', timezone: null }, now), /never runs/);
    assert.throws(() => parseSchedule({ kind: 'at', at: now - 1 }, now, { requireFuture: true }), /future/);
    assert.throws(() => parseSchedule({ kind: 'weekly' }, now), ScheduleValidationError);
    assert.throws(() => parseSchedule(null, now), ScheduleValidationError);
  });

  test('computeNextRun handles every, cron and one-shot schedules', () => {
    assert.equal(computeNextRun({ kind: 'every', everySeconds: 600 }, now), now + 600_000);
    assert.equal(iso(computeNextRun({ kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo' }, now)), '2026-10-17T00:00:00.000Z');
    assert.equal(computeNextRun({ kind: 'at', at: now + 5 }, now), now + 5);
    assert.equal(computeNextRun({ kind: 'at', at: now }, now), null);
  });

  test('previewSchedule returns the next three runs', () => {
    assert.deepEqual(previewSchedule({ kind: 'every', everySeconds: 60 }, now).map((value) => value - now), [60_000, 120_000, 180_000]);
    assert.deepEqual(previewSchedule({ kind: 'at', at: now + 1000 }, now), [now + 1000]);
  });
});
