import type { ScheduledJobRunEvent } from 'michi-shared';
import type { ChatMessage } from './chatTypes';

/**
 * Whether the thread's latest turn was sent by the scheduler (a scheduled job
 * or Space maintenance). Such runs report completion through their job's own
 * notify setting, so the generic "Streaming finished" notice must stay quiet,
 * including after a reload or on a feed that carries no scheduled-run events.
 */
export function latestTurnIsScheduled(messages: readonly ChatMessage[] | undefined): boolean {
  if (!messages) return false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return !!messages[i].scheduledJobId;
  }
  return false;
}

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
