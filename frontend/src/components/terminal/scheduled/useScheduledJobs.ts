import React from 'react';
import type { ScheduledJobDto, ScheduledJobsSchedulerStatus } from 'michi-shared';
import { listScheduledJobs } from '../../../services/api/scheduledJobs';
import { SCHEDULED_JOB_RUN_WINDOW_EVENT, SCHEDULED_JOBS_CHANGED_WINDOW_EVENT } from './scheduledNav';

const POLL_MS = 15_000;

export interface ScheduledJobsState {
  jobs: ScheduledJobDto[];
  scheduler: ScheduledJobsSchedulerStatus | null;
  loading: boolean;
  error: string | null;
  /** The backend has no scheduler (cloud server or an older backend). */
  unavailable: boolean;
}

const INITIAL: ScheduledJobsState = { jobs: [], scheduler: null, loading: true, error: null, unavailable: false };
let state = INITIAL;
let updatedAt = 0;
let generation = 0;
let inFlight: Promise<void> | null = null;
let refreshAgain = false;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function publish(next: ScheduledJobsState) {
  state = next;
  for (const listener of listeners) listener();
}

function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  const current = generation;
  const request = Promise.resolve().then(() => listScheduledJobs()).then(result => {
    if (current !== generation) return;
    updatedAt = Date.now();
    publish({ jobs: result.jobs, scheduler: result.scheduler, loading: false, error: null, unavailable: false });
  }, (reason: unknown) => {
    if (current !== generation) return;
    const message = reason instanceof Error ? reason.message : String(reason);
    const unavailable = /not available|404/.test(message);
    publish({ ...state, loading: false, unavailable, error: unavailable ? null : message });
  }).finally(() => {
    if (inFlight !== request) return;
    inFlight = null;
    if (refreshAgain) { refreshAgain = false; void refresh(); }
  });
  inFlight = request;
  return request;
}

function invalidate() {
  generation++;
  updatedAt = 0;
  if (inFlight) refreshAgain = true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    if (state.loading || Date.now() - updatedAt >= POLL_MS) void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !state.unavailable) void refresh();
    }, POLL_MS);
    let debounce: number | undefined;
    const onChange = () => {
      invalidate();
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { if (updatedAt === 0) void refresh(); }, 200);
    };
    window.addEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onChange);
    window.addEventListener(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, onChange);
    stop = () => {
      window.clearInterval(poll);
      window.clearTimeout(debounce);
      window.removeEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onChange);
      window.removeEventListener(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, onChange);
      // Events may be missed while unmounted: keep the snapshot, revalidate on return.
      updatedAt = 0;
    };
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { stop?.(); stop = null; }
  };
}

function upsert(job: ScheduledJobDto) {
  invalidate();
  const found = state.jobs.some(candidate => candidate.id === job.id);
  publish({ ...state, jobs: found ? state.jobs.map(candidate => candidate.id === job.id ? job : candidate) : [...state.jobs, job] });
}
function remove(jobId: string) {
  invalidate();
  publish({ ...state, jobs: state.jobs.filter(job => job.id !== jobId) });
}

/** One local-backend snapshot and poll shared by the sidebar and Scheduled page.
 * Cached content remains visible during revalidation and transient failures.
 * Sign-out reloads the renderer, so this in-memory cache cannot cross accounts.
 */
export function useScheduledJobs() {
  const snapshot = React.useSyncExternalStore(subscribe, () => state, () => INITIAL);
  return { ...snapshot, refresh, upsert, remove };
}

export function resetScheduledJobsStore(): void {
  generation++;
  state = INITIAL;
  updatedAt = 0;
  inFlight = null;
  refreshAgain = false;
  for (const listener of listeners) listener();
}
