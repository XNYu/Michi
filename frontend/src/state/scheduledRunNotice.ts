import type { ScheduledJobRunEvent } from 'michi-shared';

export interface ScheduledRunNoticeText {
  title: string;
  subtitle: string;
  body: string;
}

/**
 * Wording for a scheduled run notification. Mirrors describeNotice in
 * electron/scheduledNotifications.ts, which the desktop app uses instead.
 */
export function describeScheduledRunNotice(event: ScheduledJobRunEvent): ScheduledRunNoticeText | null {
  if (event.phase === 'attention') {
    return {
      title: event.jobName,
      subtitle: event.attention === 'input' ? 'Needs your input' : 'Needs your approval',
      body: 'The scheduled run is waiting. Open it to continue.',
    };
  }
  if (event.phase !== 'finished' || !event.notify) return null;
  if (event.status === 'succeeded') {
    return { title: event.jobName, subtitle: 'Scheduled job finished', body: event.summary || 'Open the thread to see the result.' };
  }
  if (event.status === 'failed' || event.status === 'timed_out') {
    return { title: event.jobName, subtitle: 'Scheduled job failed', body: event.error || 'Open the job for details.' };
  }
  return null;
}
