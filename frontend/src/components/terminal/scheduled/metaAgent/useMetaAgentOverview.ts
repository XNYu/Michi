import { useEffect, useSyncExternalStore } from 'react';
import type { MetaAgentOverview } from 'michi-shared';
import { fetchMetaAgentOverview, setMetaAgentPaused } from '../../../../services/api/metaAgentOverview';
import { HttpResponseError } from '../../../../services/api/httpError';

/**
 * The Meta agent overview shared by the Scheduled sidebar's system row and the
 * detail page: one read at a time and one poll while either is mounted.
 */
export type MetaAgentOverviewLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; overview: MetaAgentOverview; at: number }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string };

const POLL_MS = 15_000;
const INITIAL: MetaAgentOverviewLoad = { kind: 'loading' };

let load: MetaAgentOverviewLoad = INITIAL;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let generation = 0;
let pollers = 0;
let timer: number | null = null;

function publish(next: MetaAgentOverviewLoad): void {
  load = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const isOverview = (value: unknown): value is MetaAgentOverview =>
  typeof value === 'object' && value !== null && typeof (value as MetaAgentOverview).state === 'string' && Array.isArray((value as MetaAgentOverview).cursors);

export function refreshMetaAgentOverview(): Promise<void> {
  if (inflight) return inflight;
  const current = ++generation;
  inflight = fetchMetaAgentOverview().then(
    (overview) => {
      if (current !== generation) return;
      if (!isOverview(overview)) { publish({ kind: 'unavailable' }); return; }
      publish({ kind: 'ready', overview, at: Date.now() });
    },
    (reason: unknown) => {
      if (current !== generation) return;
      if (reason instanceof HttpResponseError && reason.status === 404) { publish({ kind: 'unavailable' }); return; }
      // Keep showing the last answer when a poll fails.
      if (load.kind === 'ready') return;
      publish({ kind: 'failed', message: reason instanceof Error ? reason.message : 'Could not read the Meta agent’s status' });
    },
  ).finally(() => { inflight = null; });
  return inflight;
}

/** Pauses or resumes background maintenance; the answer replaces the overview at once. */
export async function pauseMetaAgentMaintenance(paused: boolean): Promise<void> {
  const overview = await setMetaAgentPaused(paused);
  generation += 1;
  publish({ kind: 'ready', overview, at: Date.now() });
}

function startPolling(): () => void {
  pollers += 1;
  if (pollers === 1) {
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && load.kind !== 'unavailable') void refreshMetaAgentOverview();
    }, POLL_MS);
  }
  return () => {
    pollers -= 1;
    if (pollers > 0) return;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
}

/** Observe navigation validity without keeping background polling mounted. */
export function useMetaAgentOverviewSnapshot(): MetaAgentOverviewLoad {
  return useSyncExternalStore(subscribe, () => load, () => load);
}

export function useMetaAgentOverview(): MetaAgentOverviewLoad {
  const current = useMetaAgentOverviewSnapshot();
  useEffect(() => {
    void refreshMetaAgentOverview();
    return startPolling();
  }, []);
  return current;
}

export function resetMetaAgentOverviewStore(): void {
  load = INITIAL;
  inflight = null;
  generation += 1;
  for (const listener of listeners) listener();
}
