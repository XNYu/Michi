import { useSyncExternalStore } from 'react';

/** One visible destination shared by the shell, sidebar, list and notifications. */
export type ScheduledRoute = { kind: 'list' } | { kind: 'meta-agent' } | { kind: 'job'; jobId: string };
export const SCHEDULED_HOME: ScheduledRoute = { kind: 'list' };
let route: ScheduledRoute = SCHEDULED_HOME;
const listeners = new Set<() => void>();

export function setScheduledRoute(next: ScheduledRoute): void {
  if (route.kind === next.kind && (route.kind !== 'job' || (next.kind === 'job' && route.jobId === next.jobId))) return;
  route = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useScheduledRoute(): ScheduledRoute {
  return useSyncExternalStore(subscribe, () => route, () => SCHEDULED_HOME);
}

export function openScheduledHome(): void { setScheduledRoute(SCHEDULED_HOME); }

export const OPEN_SCHEDULED_JOB_EVENT = 'michi:open-scheduled-job';

/** Retained even before the Scheduled page mounts, including notification opens. */
export function requestScheduledJobDetail(jobId: string): void {
  setScheduledRoute({ kind: 'job', jobId });
  window.dispatchEvent(new CustomEvent(OPEN_SCHEDULED_JOB_EVENT, { detail: { jobId } }));
}

/** Fired by the chat store for every scheduled run lifecycle frame. */
export const SCHEDULED_JOB_RUN_WINDOW_EVENT = 'michi:scheduled-job-run';

/** Fired by the chat store when a job is created, edited or deleted elsewhere. */
export const SCHEDULED_JOBS_CHANGED_WINDOW_EVENT = 'michi:scheduled-jobs-changed';
