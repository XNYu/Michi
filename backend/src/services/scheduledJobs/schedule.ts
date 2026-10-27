import { SCHEDULED_JOB_LIMITS, type ScheduledJobSchedule } from 'michi-shared';
import { CronParseError, isValidTimeZone, nextCronRun, parseCron, systemTimeZone } from './cron';

export class ScheduleValidationError extends Error {}

/** Furthest a one-shot run may be scheduled. */
const MAX_AT_HORIZON_MS = 5 * 366 * 24 * 3_600_000;

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

/**
 * Validate an untrusted schedule payload. `requireFuture` rejects a one-shot
 * time that already passed (used when the schedule itself is being set).
 */
export function parseSchedule(raw: unknown, now: number, opts: { requireFuture?: boolean } = {}): ScheduledJobSchedule {
  if (!raw || typeof raw !== 'object') throw new ScheduleValidationError('schedule is required');
  const value = raw as Record<string, unknown>;
  switch (value.kind) {
    case 'every': {
      const seconds = finiteInteger(value.everySeconds);
      if (seconds === null) throw new ScheduleValidationError('Interval must be a whole number of seconds');
      if (seconds < SCHEDULED_JOB_LIMITS.minEverySeconds) {
        throw new ScheduleValidationError('Interval must be at least 1 minute');
      }
      if (seconds > SCHEDULED_JOB_LIMITS.maxEverySeconds) {
        throw new ScheduleValidationError('Interval must be at most 366 days');
      }
      return { kind: 'every', everySeconds: seconds };
    }
    case 'cron': {
      if (typeof value.expression !== 'string') throw new ScheduleValidationError('Cron expression is required');
      const expression = value.expression.trim().replace(/\s+/g, ' ');
      if (expression.length > SCHEDULED_JOB_LIMITS.cronExpression) {
        throw new ScheduleValidationError('Cron expression is too long');
      }
      let timezone: string | null = null;
      if (value.timezone !== undefined && value.timezone !== null && value.timezone !== '') {
        if (typeof value.timezone !== 'string' || !isValidTimeZone(value.timezone)) {
          throw new ScheduleValidationError('Unknown timezone');
        }
        timezone = value.timezone;
      }
      let spec;
      try {
        spec = parseCron(expression);
      } catch (error) {
        throw new ScheduleValidationError(error instanceof CronParseError ? error.message : 'Invalid cron expression');
      }
      if (nextCronRun(spec, now, timezone ?? systemTimeZone()) === null) {
        throw new ScheduleValidationError('This cron expression never runs');
      }
      return { kind: 'cron', expression, timezone };
    }
    case 'at': {
      const at = finiteInteger(value.at);
      if (at === null || at <= 0) throw new ScheduleValidationError('Run time is required');
      if (opts.requireFuture && at <= now) throw new ScheduleValidationError('Run time must be in the future');
      if (at > now + MAX_AT_HORIZON_MS) throw new ScheduleValidationError('Run time is too far in the future');
      return { kind: 'at', at };
    }
    default:
      throw new ScheduleValidationError('Unknown schedule type');
  }
}

/** Next due instant strictly after `after`, or null when the schedule is finished. */
export function computeNextRun(schedule: ScheduledJobSchedule, after: number): number | null {
  switch (schedule.kind) {
    case 'every':
      return after + schedule.everySeconds * 1000;
    case 'cron':
      try {
        return nextCronRun(parseCron(schedule.expression), after, schedule.timezone ?? systemTimeZone());
      } catch {
        return null;
      }
    case 'at':
      return schedule.at > after ? schedule.at : null;
  }
}

/** The next `count` due instants, for the editor preview. */
export function previewSchedule(schedule: ScheduledJobSchedule, now: number, count = 3): number[] {
  const runs: number[] = [];
  let cursor = now;
  for (let index = 0; index < count; index += 1) {
    const next = computeNextRun(schedule, cursor);
    if (next === null) break;
    runs.push(next);
    if (schedule.kind === 'at') break;
    cursor = next;
  }
  return runs;
}

export { systemTimeZone };
