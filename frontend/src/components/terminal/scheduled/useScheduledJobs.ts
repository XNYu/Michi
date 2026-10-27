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

/** Job list with light polling, refreshed immediately on run and job-change events. */
export function useScheduledJobs() {
  const [state, setState] = React.useState<ScheduledJobsState>({
    jobs: [], scheduler: null, loading: true, error: null, unavailable: false,
  });
  const mounted = React.useRef(true);
  const inFlight = React.useRef<AbortController | null>(null);

  const refresh = React.useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const result = await listScheduledJobs(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setState({ jobs: result.jobs, scheduler: result.scheduler, loading: false, error: null, unavailable: false });
    } catch (reason) {
      if (!mounted.current || controller.signal.aborted) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      const unavailable = /not available|404/.test(message);
      setState((current) => ({ ...current, loading: false, unavailable, error: unavailable ? null : message }));
    }
  }, []);

  React.useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    let debounce: number | undefined;
    const onRun = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { void refresh(); }, 200);
    };
    window.addEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
    window.addEventListener(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, onRun);
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
      window.clearInterval(poll);
      window.clearTimeout(debounce);
      window.removeEventListener(SCHEDULED_JOB_RUN_WINDOW_EVENT, onRun);
      window.removeEventListener(SCHEDULED_JOBS_CHANGED_WINDOW_EVENT, onRun);
    };
  }, [refresh]);

  const upsert = React.useCallback((job: ScheduledJobDto) => {
    setState((current) => {
      const index = current.jobs.findIndex((candidate) => candidate.id === job.id);
      const jobs = index < 0 ? [...current.jobs, job] : current.jobs.map((candidate) => (candidate.id === job.id ? job : candidate));
      return { ...current, jobs };
    });
  }, []);

  const remove = React.useCallback((jobId: string) => {
    setState((current) => ({ ...current, jobs: current.jobs.filter((job) => job.id !== jobId) }));
  }, []);

  return { ...state, refresh, upsert, remove };
}
