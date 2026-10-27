import type { ScheduledJobRunStatus, ScheduledJobSchedule } from 'michi-shared';

/** Editor-friendly representation of a schedule. Presets compile to cron. */
export type ScheduleMode = 'interval' | 'daily' | 'weekdays' | 'weekly' | 'once' | 'cron';
export type IntervalUnit = 'minutes' | 'hours' | 'days';

export interface ScheduleDraft {
  mode: ScheduleMode;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  /** HH:MM, 24h. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  cron: string;
  timezone: string;
  /** datetime-local value: YYYY-MM-DDTHH:MM in the browser's zone. */
  onceAt: string;
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const SCHEDULE_MODE_LABELS: Record<ScheduleMode, string> = {
  interval: 'Interval',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  once: 'Once',
  cron: 'Cron',
};

const UNIT_SECONDS: Record<IntervalUnit, number> = { minutes: 60, hours: 3600, days: 86_400 };

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function toDateTimeLocal(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function defaultScheduleDraft(now: number = Date.now()): ScheduleDraft {
  const tomorrowNine = new Date(now);
  tomorrowNine.setDate(tomorrowNine.getDate() + 1);
  tomorrowNine.setHours(9, 0, 0, 0);
  return {
    mode: 'daily',
    intervalValue: 1,
    intervalUnit: 'hours',
    time: '09:00',
    weekdays: [1],
    cron: '0 9 * * 1-5',
    timezone: localTimeZone(),
    onceAt: toDateTimeLocal(tomorrowNine.getTime()),
  };
}

function parseTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export type DraftResult = { schedule: ScheduledJobSchedule; error?: undefined } | { schedule?: undefined; error: string };

/** Compile the editor draft into the API schedule, or explain what is missing. */
export function draftToSchedule(draft: ScheduleDraft): DraftResult {
  const timezone = draft.timezone || null;
  switch (draft.mode) {
    case 'interval': {
      const value = Math.floor(Number(draft.intervalValue));
      if (!Number.isFinite(value) || value < 1) return { error: 'Enter how often to run' };
      const seconds = value * UNIT_SECONDS[draft.intervalUnit];
      if (seconds < 60) return { error: 'Run at most once a minute' };
      return { schedule: { kind: 'every', everySeconds: seconds } };
    }
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const time = parseTime(draft.time);
      if (!time) return { error: 'Pick a time' };
      let days = '*';
      if (draft.mode === 'weekdays') days = '1-5';
      if (draft.mode === 'weekly') {
        const selected = [...new Set(draft.weekdays)].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
        if (selected.length === 0) return { error: 'Pick at least one day' };
        days = selected.join(',');
      }
      return { schedule: { kind: 'cron', expression: `${time.minute} ${time.hour} * * ${days}`, timezone } };
    }
    case 'once': {
      const at = new Date(draft.onceAt).getTime();
      if (!draft.onceAt || !Number.isFinite(at)) return { error: 'Pick a date and time' };
      return { schedule: { kind: 'at', at } };
    }
    case 'cron': {
      const expression = draft.cron.trim().replace(/\s+/g, ' ');
      if (!expression) return { error: 'Enter a cron expression' };
      return { schedule: { kind: 'cron', expression, timezone } };
    }
  }
}

const SIMPLE_CRON = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/;

/** Inverse of draftToSchedule; unknown cron shapes open in Cron mode. */
export function scheduleToDraft(schedule: ScheduledJobSchedule, now: number = Date.now()): ScheduleDraft {
  const draft = defaultScheduleDraft(now);
  if (schedule.kind === 'every') {
    const unit: IntervalUnit = schedule.everySeconds % 86_400 === 0 ? 'days'
      : schedule.everySeconds % 3600 === 0 ? 'hours'
        : 'minutes';
    return { ...draft, mode: 'interval', intervalUnit: unit, intervalValue: Math.max(1, Math.round(schedule.everySeconds / UNIT_SECONDS[unit])) };
  }
  if (schedule.kind === 'at') return { ...draft, mode: 'once', onceAt: toDateTimeLocal(schedule.at) };
  const timezone = schedule.timezone ?? draft.timezone;
  const match = SIMPLE_CRON.exec(schedule.expression);
  if (match && Number(match[1]) <= 59 && Number(match[2]) <= 23) {
    const time = `${pad(Number(match[2]))}:${pad(Number(match[1]))}`;
    if (match[3] === '*') return { ...draft, mode: 'daily', time, timezone, cron: schedule.expression };
    if (match[3] === '1-5') return { ...draft, mode: 'weekdays', time, timezone, cron: schedule.expression };
    return { ...draft, mode: 'weekly', time, timezone, cron: schedule.expression, weekdays: match[3].split(',').map(Number) };
  }
  return { ...draft, mode: 'cron', cron: schedule.expression, timezone };
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

function formatClock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** One-line human description, e.g. "Weekdays at 09:00". */
export function describeSchedule(schedule: ScheduledJobSchedule, viewerTimeZone: string = localTimeZone()): string {
  if (schedule.kind === 'every') {
    const seconds = schedule.everySeconds;
    if (seconds % 86_400 === 0) return seconds === 86_400 ? 'Every day' : `Every ${plural(seconds / 86_400, 'day')}`;
    if (seconds % 3600 === 0) return seconds === 3600 ? 'Every hour' : `Every ${plural(seconds / 3600, 'hour')}`;
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? 'Every minute' : `Every ${plural(minutes, 'minute')}`;
  }
  if (schedule.kind === 'at') return `Once · ${formatDateTime(schedule.at)}`;
  const zone = schedule.timezone && schedule.timezone !== viewerTimeZone ? ` (${schedule.timezone})` : '';
  const match = SIMPLE_CRON.exec(schedule.expression);
  if (match && Number(match[1]) <= 59 && Number(match[2]) <= 23) {
    const clock = formatClock(Number(match[2]), Number(match[1]));
    if (match[3] === '*') return `Daily at ${clock}${zone}`;
    if (match[3] === '1-5') return `Weekdays at ${clock}${zone}`;
    const days = match[3].split(',').map((day) => WEEKDAY_LABELS[Number(day)]);
    return `${days.length === 7 ? 'Daily' : days.join(', ')} at ${clock}${zone}`;
  }
  return `Cron ${schedule.expression}${zone}`;
}

export function formatDateTime(ms: number, now: number = Date.now()): string {
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** "in 5 min", "in 3 h", "2 days ago", "just now". */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const delta = ms - now;
  const abs = Math.abs(delta);
  const future = delta > 0;
  if (abs < 45_000) return future ? 'in a moment' : 'just now';
  const minutes = Math.round(abs / 60_000);
  let text: string;
  if (minutes < 60) text = `${minutes} min`;
  else if (minutes < 60 * 36) text = `${Math.round(minutes / 60)} h`;
  else text = plural(Math.round(minutes / 1440), 'day');
  return future ? `in ${text}` : `${text} ago`;
}

/**
 * Relative time for something that already happened. A timestamp newer than
 * a periodically refreshed `now` (a run that just started) reads "just now",
 * never "in a moment".
 */
export function relativePastTime(ms: number, now: number = Date.now()): string {
  return relativeTime(ms, Math.max(ms, now));
}

export function formatDuration(startedAt: number, finishedAt: number | null, now: number = Date.now()): string {
  const ms = Math.max(0, (finishedAt ?? now) - startedAt);
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

export const RUN_STATUS_LABELS: Record<ScheduledJobRunStatus, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
  interrupted: 'Interrupted',
};

export type StatusTone = 'ok' | 'error' | 'muted' | 'active';

export function runStatusTone(status: ScheduledJobRunStatus | null): StatusTone {
  if (status === 'running') return 'active';
  if (status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'timed_out') return 'error';
  return 'muted';
}

/** IANA zones for the picker, with the local zone first. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const local = localTimeZone();
  const ordered = [local, ...zones.filter((zone) => zone !== local)];
  if (current && !ordered.includes(current)) ordered.unshift(current);
  if (!ordered.includes('UTC')) ordered.push('UTC');
  return ordered;
}
