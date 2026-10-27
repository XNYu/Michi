import {
  SCHEDULED_JOB_RUN_EVENT,
  SCHEDULED_JOBS_CHANGED_EVENT,
  type ScheduledJobRunEvent,
  type ScheduledJobsChangedEvent,
} from 'michi-shared';

/** One SSE frame for a scheduled run event. */
export function encodeScheduledJobEvent(event: ScheduledJobRunEvent): string {
  return `event: ${SCHEDULED_JOB_RUN_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** One SSE frame for a job created, edited or deleted. */
export function encodeScheduledJobsChangedEvent(event: ScheduledJobsChangedEvent): string {
  return `event: ${SCHEDULED_JOBS_CHANGED_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface ScheduledJobEventSubscriber {
  send(event: ScheduledJobRunEvent): void;
  /** Job definition changes; only renderer feeds subscribe to these. */
  sendChange?(event: ScheduledJobsChangedEvent): void;
  /**
   * Desktop notifiers (the Electron main process) deliver OS notifications.
   * Renderer feeds only refresh their view and are not counted.
   */
  notifier?: boolean;
}

/**
 * In-process fan-out for scheduled run lifecycle events. The renderer
 * background feed and the Electron notification feed both subscribe here.
 */
export class ScheduledJobEventBus {
  private readonly subscribers = new Set<ScheduledJobEventSubscriber>();
  private lastNotifierSeenAt: number;

  constructor(private readonly clock: () => number = Date.now) {
    // Treat boot as "recently seen" so a notifier that is reconnecting after a
    // backend restart is not mistaken for an absent app.
    this.lastNotifierSeenAt = clock();
  }

  subscribe(subscriber: ScheduledJobEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (subscriber.notifier) this.lastNotifierSeenAt = this.clock();
    return () => {
      if (!this.subscribers.delete(subscriber)) return;
      if (subscriber.notifier) this.lastNotifierSeenAt = this.clock();
    };
  }

  publish(event: ScheduledJobRunEvent): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.send(event);
      } catch {
        // One broken stream must not stop the others.
      }
    }
  }

  publishChange(event: ScheduledJobsChangedEvent): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.sendChange?.(event);
      } catch {
        // One broken stream must not stop the others.
      }
    }
  }

  hasNotifier(): boolean {
    for (const subscriber of this.subscribers) if (subscriber.notifier) return true;
    return false;
  }

  /** Milliseconds since a notifier was last connected (0 while one is connected). */
  notifierAbsentForMs(): number {
    return this.hasNotifier() ? 0 : Math.max(0, this.clock() - this.lastNotifierSeenAt);
  }
}

export const scheduledJobEvents = new ScheduledJobEventBus();
