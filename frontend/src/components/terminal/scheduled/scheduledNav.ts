/**
 * Cross-component request to show one job's details. The Scheduled page may
 * not be mounted yet when the request is made (e.g. from a notification), so
 * the request is held until the page reads it.
 */
let pendingJobId: string | null = null;

export const OPEN_SCHEDULED_JOB_EVENT = 'michi:open-scheduled-job';

export function requestScheduledJobDetail(jobId: string): void {
  pendingJobId = jobId;
  window.dispatchEvent(new CustomEvent(OPEN_SCHEDULED_JOB_EVENT, { detail: { jobId } }));
}

export function takePendingScheduledJob(): string | null {
  const jobId = pendingJobId;
  pendingJobId = null;
  return jobId;
}

/** Fired by the chat store for every scheduled run lifecycle frame. */
export const SCHEDULED_JOB_RUN_WINDOW_EVENT = 'michi:scheduled-job-run';

/** Fired by the chat store when a job is created, edited or deleted elsewhere. */
export const SCHEDULED_JOBS_CHANGED_WINDOW_EVENT = 'michi:scheduled-jobs-changed';
