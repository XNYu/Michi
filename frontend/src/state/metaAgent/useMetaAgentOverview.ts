import { useEffect, useSyncExternalStore } from 'react';
import type { MetaAgentOverview } from 'michi-shared';
import { fetchMetaAgentOverview, setMetaAgentPaused } from '../../services/api/metaAgentOverview';
import { useMetaAgentGuardFailed, useMetaAgentSnapshot } from './useMetaAgent';
import { useSpacesFirstRun } from './spacesFirstRun';
import { metaAgentStatus } from './metaAgentStatus';

/**
 * Scheduled › Meta agent's overview as the Spaces Home reads it: whether
 * maintenance is paused, each workspace's cursor and the recent runs.
 * `unavailable`: the backend has no overview route, or it is not this
 * machine's own backend.
 */
export interface MetaAgentOverviewSnapshot {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  overview: MetaAgentOverview | null;
  error: string | null;
}

const INITIAL: MetaAgentOverviewSnapshot = { status: 'loading', overview: null, error: null };
const OVERVIEW_POLL_MS = 60_000;

let snapshot = INITIAL;
let generation = 0;
let readers = 0;
let timer: number | null = null;
const listeners = new Set<() => void>();

function publish(next: MetaAgentOverviewSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function readMetaAgentOverview(): MetaAgentOverviewSnapshot {
  return snapshot;
}

export async function refreshMetaAgentOverview(): Promise<MetaAgentOverview | null> {
  const mine = ++generation;
  try {
    const overview = await fetchMetaAgentOverview();
    if (mine === generation) publish({ status: 'ready', overview, error: null });
    return overview;
  } catch (error) {
    if (mine !== generation) return null;
    const status = (error as { status?: unknown })?.status;
    const message = error instanceof Error ? error.message : 'Could not read the Meta agent overview';
    if (status === 403 || status === 404) publish({ status: 'unavailable', overview: null, error: null });
    else publish({ status: snapshot.overview ? 'ready' : 'error', overview: snapshot.overview, error: message });
    return null;
  }
}

/** Resumes background maintenance in every workspace. */
export async function resumeMetaAgent(): Promise<void> {
  const overview = await setMetaAgentPaused(false);
  generation += 1;
  publish({ status: 'ready', overview, error: null });
}

const onFocus = () => { void refreshMetaAgentOverview(); };

/** The overview, read when the caller mounts and kept fresh while it stays mounted. */
export function useMetaAgentOverview(): MetaAgentOverviewSnapshot {
  const current = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readMetaAgentOverview,
    readMetaAgentOverview,
  );
  useEffect(() => {
    void refreshMetaAgentOverview();
    readers += 1;
    if (readers === 1) {
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible' && snapshot.status !== 'unavailable') void refreshMetaAgentOverview();
      }, OVERVIEW_POLL_MS);
      window.addEventListener('focus', onFocus);
    }
    return () => {
      readers -= 1;
      if (readers > 0) return;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return current;
}

export function resetMetaAgentOverviewStore(): void {
  snapshot = INITIAL;
  generation = 0;
  for (const listener of listeners) listener();
}

/**
 * The rail's Settings red dot: the shared Meta agent status says Settings can
 * fix it (a failed restriction check, a runtime it cannot run on, or errors
 * that stopped background maintenance), not a pause or scheduled jobs being off.
 */
export function useMetaAgentSettingsAlert(): boolean {
  // Keeps the restriction checks fresh while the rail is mounted.
  useMetaAgentGuardFailed();
  const agent = useMetaAgentSnapshot();
  const overview = useMetaAgentOverview();
  const firstRun = useSpacesFirstRun('local');
  return !!agent.info?.toolApprovals?.some(request => request.state === 'pending') || metaAgentStatus({ info: agent.info, infoStatus: agent.status, firstRun, overview: overview.overview }).settingsAlert;
}
