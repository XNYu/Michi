import { describe, expect, it } from 'vitest';
import {
  defaultScheduleDraft,
  describeSchedule,
  draftToSchedule,
  formatDuration,
  relativePastTime,
  relativeTime,
  scheduleToDraft,
  type ScheduleDraft,
} from './scheduleModel';
import { validateJobForm, formValueFromJob } from './ScheduledJobEditor';

const base: ScheduleDraft = { ...defaultScheduleDraft(Date.parse('2026-10-16T12:00:00')), timezone: 'Asia/Tokyo' };

describe('draftToSchedule', () => {
  it('compiles presets to interval and cron schedules', () => {
    expect(draftToSchedule({ ...base, mode: 'interval', intervalValue: 30, intervalUnit: 'minutes' }).schedule)
      .toEqual({ kind: 'every', everySeconds: 1800 });
    expect(draftToSchedule({ ...base, mode: 'daily', time: '07:05' }).schedule)
      .toEqual({ kind: 'cron', expression: '5 7 * * *', timezone: 'Asia/Tokyo' });
    expect(draftToSchedule({ ...base, mode: 'weekdays', time: '09:00' }).schedule)
      .toEqual({ kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Tokyo' });
    expect(draftToSchedule({ ...base, mode: 'weekly', time: '18:30', weekdays: [5, 1, 1] }).schedule)
      .toEqual({ kind: 'cron', expression: '30 18 * * 1,5', timezone: 'Asia/Tokyo' });
    expect(draftToSchedule({ ...base, mode: 'cron', cron: ' */10  * * * * ' }).schedule)
      .toEqual({ kind: 'cron', expression: '*/10 * * * *', timezone: 'Asia/Tokyo' });
    expect(draftToSchedule({ ...base, mode: 'once', onceAt: '2026-10-17T09:00' }).schedule)
      .toEqual({ kind: 'at', at: new Date('2026-10-17T09:00').getTime() });
  });

  it('explains incomplete drafts', () => {
    expect(draftToSchedule({ ...base, mode: 'interval', intervalValue: 0 }).error).toBeTruthy();
    expect(draftToSchedule({ ...base, mode: 'weekly', weekdays: [] }).error).toMatch(/day/);
    expect(draftToSchedule({ ...base, mode: 'daily', time: '' }).error).toMatch(/time/);
    expect(draftToSchedule({ ...base, mode: 'cron', cron: ' ' }).error).toMatch(/cron/);
    expect(draftToSchedule({ ...base, mode: 'once', onceAt: '' }).error).toMatch(/date/);
  });
});

describe('scheduleToDraft', () => {
  it('reopens simple cron schedules in their preset', () => {
    expect(scheduleToDraft({ kind: 'cron', expression: '5 7 * * *', timezone: 'UTC' })).toMatchObject({ mode: 'daily', time: '07:05', timezone: 'UTC' });
    expect(scheduleToDraft({ kind: 'cron', expression: '0 9 * * 1-5', timezone: null }).mode).toBe('weekdays');
    expect(scheduleToDraft({ kind: 'cron', expression: '30 18 * * 1,5', timezone: null })).toMatchObject({ mode: 'weekly', weekdays: [1, 5] });
    expect(scheduleToDraft({ kind: 'cron', expression: '*/5 9-17 * * *', timezone: null })).toMatchObject({ mode: 'cron', cron: '*/5 9-17 * * *' });
    expect(scheduleToDraft({ kind: 'every', everySeconds: 7200 })).toMatchObject({ mode: 'interval', intervalValue: 2, intervalUnit: 'hours' });
    expect(scheduleToDraft({ kind: 'every', everySeconds: 600 })).toMatchObject({ intervalValue: 10, intervalUnit: 'minutes' });
  });
});

describe('describeSchedule', () => {
  it('reads like a sentence', () => {
    expect(describeSchedule({ kind: 'every', everySeconds: 60 }, 'UTC')).toBe('Every minute');
    expect(describeSchedule({ kind: 'every', everySeconds: 3600 }, 'UTC')).toBe('Every hour');
    expect(describeSchedule({ kind: 'every', everySeconds: 172_800 }, 'UTC')).toBe('Every 2 days');
    expect(describeSchedule({ kind: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' }, 'UTC')).toBe('Weekdays at 09:00');
    expect(describeSchedule({ kind: 'cron', expression: '30 18 * * 1,5', timezone: 'UTC' }, 'UTC')).toBe('Mon, Fri at 18:30');
    expect(describeSchedule({ kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Tokyo' }, 'UTC')).toBe('Daily at 09:00 (Asia/Tokyo)');
    expect(describeSchedule({ kind: 'cron', expression: '*/5 * * * *', timezone: null }, 'UTC')).toBe('Cron */5 * * * *');
  });
});

describe('time helpers', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  it('formats relative times and durations', () => {
    expect(relativeTime(now + 10_000, now)).toBe('in a moment');
    expect(relativeTime(now + 5 * 60_000, now)).toBe('in 5 min');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now + 3 * 86_400_000, now)).toBe('in 3 days');
    // A run stamped after the last `now` tick still happened in the past.
    expect(relativePastTime(now + 10_000, now)).toBe('just now');
    expect(relativePastTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatDuration(now, now + 42_000)).toBe('42s');
    expect(formatDuration(now, now + 125_000)).toBe('2m 05s');
    expect(formatDuration(now, now + 3_725_000)).toBe('1h 02m');
  });
});

describe('validateJobForm', () => {
  it('requires a name, workspace, prompt and valid schedule', () => {
    const empty = formValueFromJob(null, { workspaceId: '' });
    const { errors, input } = validateJobForm(empty);
    expect(input).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(['name', 'prompt', 'workspaceId']);
  });

  it('builds the API input and drops model fields for the default agent', () => {
    const value = {
      ...formValueFromJob(null, { workspaceId: 'ws-1' }),
      name: ' Digest ', prompt: ' Summarize ', modelId: 'stale', timeoutMinutes: 15,
    };
    const { input } = validateJobForm(value);
    expect(input).toMatchObject({
      name: 'Digest', prompt: 'Summarize', workspaceId: 'ws-1', runtimeId: null, modelId: null,
      permissionMode: 'trust', sessionMode: 'persistent', notify: true, timeoutSeconds: 900,
    });
    expect(input?.schedule.kind).toBe('cron');
  });
});
