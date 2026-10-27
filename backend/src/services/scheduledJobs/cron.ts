/**
 * Minimal, dependency-free 5-field cron evaluator with IANA timezone support.
 *
 * Fields: minute hour day-of-month month day-of-week. Supports `*`, `?`,
 * lists (`1,5`), ranges (`1-5`), steps (`*\/15`, `0-30/5`, `10/5`), month and
 * weekday names (JAN-DEC, SUN-SAT), weekday 7 as Sunday, and the macros
 * @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly.
 *
 * Day matching follows Vixie cron: when both day-of-month and day-of-week are
 * restricted (do not start with `*` or `?`), a day matches if EITHER matches.
 *
 * DST: wall-clock times are resolved in the schedule's timezone. A time that
 * occurs twice (fall back) fires once, at its first occurrence, unless the
 * minute or hour field is a wildcard (then it follows real time and fires in
 * both hours, like Vixie cron). A time that does not exist (spring forward)
 * fires at the equivalent shifted instant (02:30 becomes 03:30 when
 * 02:00-03:00 is skipped).
 */

export class CronParseError extends Error {}

export interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  /** Minute or hour is a wildcard, so the job follows real elapsed time. */
  repeatsInOverlap: boolean;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldDef {
  label: string;
  min: number;
  max: number;
  /** Names map to min + index. */
  names?: string[];
}

const FIELDS: FieldDef[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES },
  // 7 is accepted as Sunday and normalized below.
  { label: 'day of week', min: 0, max: 7, names: DOW_NAMES },
];

function parseValue(token: string, def: FieldDef): number {
  const upper = token.toUpperCase();
  if (def.names) {
    const index = def.names.indexOf(upper);
    if (index >= 0) return def.min + index;
  }
  if (!/^\d{1,2}$/.test(token)) {
    throw new CronParseError(`Invalid ${def.label} value "${token}"`);
  }
  const value = Number(token);
  if (value < def.min || value > def.max) {
    throw new CronParseError(`${def.label} value ${value} is outside ${def.min}-${def.max}`);
  }
  return value;
}

function parseField(text: string, def: FieldDef): Set<number> {
  if (!text) throw new CronParseError(`Missing ${def.label} field`);
  const values = new Set<number>();
  for (const part of text.split(',')) {
    if (!part) throw new CronParseError(`Empty list item in ${def.label} field`);
    const pieces = part.split('/');
    if (pieces.length > 2) throw new CronParseError(`Invalid step in ${def.label} field "${part}"`);
    const [rangeText, stepText] = pieces;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) < 1) {
        throw new CronParseError(`Invalid step "${stepText}" in ${def.label} field`);
      }
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (rangeText === '*' || rangeText === '?') {
      start = def.min;
      end = def.max;
    } else if (rangeText.includes('-')) {
      const bounds = rangeText.split('-');
      if (bounds.length !== 2) throw new CronParseError(`Invalid range "${rangeText}" in ${def.label} field`);
      start = parseValue(bounds[0], def);
      end = parseValue(bounds[1], def);
      if (start > end) {
        throw new CronParseError(`Range ${rangeText} in ${def.label} field must go from low to high`);
      }
    } else {
      start = parseValue(rangeText, def);
      end = stepText !== undefined ? def.max : start;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim();
  if (!trimmed) throw new CronParseError('Cron expression is empty');
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (expanded.startsWith('@')) throw new CronParseError(`Unknown macro "${trimmed}"`);
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError('Cron expression needs 5 fields: minute hour day-of-month month day-of-week');
  }
  const [minuteSet, hourSet, domSet, monthSet, dowRaw] = fields.map((field, index) => parseField(field, FIELDS[index]));
  const dowSet = new Set<number>();
  for (const value of dowRaw) dowSet.add(value === 7 ? 0 : value);
  const restricted = (field: string) => !field.startsWith('*') && !field.startsWith('?');
  return {
    minutes: [...minuteSet].sort((a, b) => a - b),
    hours: [...hourSet].sort((a, b) => a - b),
    daysOfMonth: domSet,
    months: monthSet,
    daysOfWeek: dowSet,
    domRestricted: restricted(fields[2]),
    dowRestricted: restricted(fields[4]),
    repeatsInOverlap: !restricted(fields[0]) || !restricted(fields[1]),
  };
}

// ── Timezone helpers ──────────────────────────────────────────────────────

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 100) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function wallClockAt(instantMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds still render midnight as 24 even with h23.
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

function offsetAt(instantMs: number, timeZone: string): number {
  const wall = wallClockAt(instantMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Every instant at which a local wall-clock minute occurs, ascending: two
 * during a fall-back overlap, one normally, and for a nonexistent time
 * (spring-forward gap) the single instant shifted forward by the gap.
 */
export function wallClockInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number[] {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Offsets on both sides of any nearby transition. Real-world transitions are
  // never less than 12 hours apart.
  const offsets = new Set([
    offsetAt(asUtc - 12 * 3_600_000, timeZone),
    offsetAt(asUtc, timeZone),
    offsetAt(asUtc + 12 * 3_600_000, timeZone),
  ]);
  const candidates = [...new Set([...offsets].map((offset) => asUtc - offset))];
  const exact = candidates.filter((candidate) => {
    const wall = wallClockAt(candidate, timeZone);
    return wall.year === year && wall.month === month && wall.day === day
      && wall.hour === hour && wall.minute === minute;
  });
  if (exact.length > 0) return exact.sort((a, b) => a - b);
  // Nonexistent local time: the latest candidate is the time shifted forward
  // by the size of the gap.
  return [Math.max(...candidates)];
}

/** First instant of a local wall-clock minute (see DST notes above). */
export function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  return wallClockInstants(year, month, day, hour, minute, timeZone)[0];
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const domMatch = spec.daysOfMonth.has(day);
  const dowMatch = spec.daysOfWeek.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  if (spec.domRestricted) return domMatch;
  if (spec.dowRestricted) return dowMatch;
  return true;
}

/** Search horizon. Covers leap-day schedules (at most 8 years apart). */
const MAX_SEARCH_DAYS = 366 * 9;
/** Upper bound on how far a DST transition can move a wall-clock time. */
const DST_SLACK_HOURS = 3;

/**
 * First instant strictly after `afterMs` that matches `spec` in `timeZone`,
 * or null if the expression can never fire (e.g. `0 0 30 2 *`).
 */
export function nextCronRun(spec: CronSpec, afterMs: number, timeZone: string): number | null {
  const start = wallClockAt(afterMs, timeZone);
  let year = start.year;
  let month = start.month;
  let day = start.day;
  // Start one day early so a DST-shifted candidate from the previous local
  // date is still considered; it is filtered by `> afterMs` below.
  ({ year, month, day } = addDays(year, month, day, -1));
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
    if (day <= daysInMonth(year, month) && dayMatches(spec, year, month, day)) {
      const isPreviousDay = offset === 0;
      const isStartDay = offset === 1;
      let best: number | null = null;
      let bestHour = -1;
      for (const hour of spec.hours) {
        // DST shifts move a wall time by at most a few hours, so hours well
        // before the start (or well after the first hit) cannot win.
        if (best !== null && hour > bestHour + DST_SLACK_HOURS) break;
        if (isPreviousDay && hour < 24 - DST_SLACK_HOURS) continue;
        if (isStartDay && hour < start.hour - DST_SLACK_HOURS) continue;
        for (const minute of spec.minutes) {
          const instants = wallClockInstants(year, month, day, hour, minute, timeZone);
          // Fixed-time jobs fire once in a repeated hour; wildcard jobs fire
          // on each real occurrence (Vixie cron semantics).
          for (const instant of spec.repeatsInOverlap ? instants : instants.slice(0, 1)) {
            if (instant > afterMs && (best === null || instant < best)) {
              best = instant;
              bestHour = hour;
            }
          }
        }
      }
      if (best !== null) return best;
    }
    ({ year, month, day } = addDays(year, month, day, 1));
  }
  return null;
}

function addDays(year: number, month: number, day: number, delta: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
