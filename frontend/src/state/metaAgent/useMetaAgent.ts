import { useEffect, useSyncExternalStore } from 'react';
import type { MetaAgentGuardStatus, MetaAgentSettingsPatch } from 'michi-shared';
import {
  fetchMetaAgent, isMetaAgentUnavailable, retryMetaAgentGuard as retryGuard, updateMetaAgentSettings, type MetaAgentInfo,
} from '../../services/api/metaAgent';

/** `unavailable`: this backend has no Meta agent routes yet. */
export type MetaAgentStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface MetaAgentSnapshot {
  status: MetaAgentStatus;
  info: MetaAgentInfo | null;
  error: string | null;
}

const INITIAL: MetaAgentSnapshot = { status: 'loading', info: null, error: null };
const GUARD_POLL_MS = 60_000;

let snapshot = INITIAL;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let readGeneration = 0;
let pollers = 0;
let pollTimer: number | null = null;

function publish(next: MetaAgentSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readMetaAgent(): MetaAgentSnapshot {
  return snapshot;
}

/** One read at a time; every caller of a read in flight shares it. */
export function refreshMetaAgent(): Promise<void> {
  if (inflight) return inflight;
  const generation = ++readGeneration;
  inflight = fetchMetaAgent().then(
    (info) => { if (generation === readGeneration) publish({ status: 'ready', info, error: null }); },
    (err: unknown) => {
      if (generation !== readGeneration) return;
      if (isMetaAgentUnavailable(err)) { publish({ status: 'unavailable', info: null, error: null }); return; }
      const message = err instanceof Error ? err.message : "Couldn't load the Meta agent";
      publish({ status: snapshot.info ? 'ready' : 'error', info: snapshot.info, error: message });
    },
  ).finally(() => { inflight = null; });
  return inflight;
}

export async function saveMetaAgentSettings(patch: MetaAgentSettingsPatch): Promise<MetaAgentInfo> {
  const info = await updateMetaAgentSettings(patch);
  // A read that started before this save must not overwrite its answer.
  readGeneration += 1;
  publish({ status: 'ready', info, error: null });
  return info;
}

/**
 * Retry after a failed restriction check: clears the failed toolset's check
 * (both when both failed) and shows the answer. With no failure on record it
 * only re-reads the status.
 */
export async function retryMetaAgentGuard(): Promise<void> {
  const failed = metaAgentGuardFailures(snapshot.info).map((status) => status.toolset);
  if (failed.length === 0) { await refreshMetaAgent(); return; }
  const info = await retryGuard(failed.length === 1 ? failed[0] : undefined);
  // A read that started before this retry must not overwrite its answer.
  readGeneration += 1;
  publish({ status: 'ready', info, error: null });
}

export function metaAgentGuardFailures(info: MetaAgentInfo | null): MetaAgentGuardStatus[] {
  if (!info) return [];
  return [info.guard.maintenance, info.guard.chat].filter((status): status is MetaAgentGuardStatus => status?.state === 'failed');
}

/** The Meta agent settings and status as last read, without reading them again. */
export function useMetaAgentSnapshot(): MetaAgentSnapshot {
  return useSyncExternalStore(subscribe, readMetaAgent, readMetaAgent);
}

/** The Meta agent settings and status, read fresh when the caller mounts. */
export function useMetaAgent(): MetaAgentSnapshot {
  const current = useMetaAgentSnapshot();
  useEffect(() => { void refreshMetaAgent(); }, []);
  return current;
}

const refreshOnFocus = () => { void refreshMetaAgent(); };

function startGuardPolling(): () => void {
  pollers += 1;
  if (pollers === 1) {
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && snapshot.status !== 'unavailable') void refreshMetaAgent();
    }, GUARD_POLL_MS);
    window.addEventListener('focus', refreshOnFocus);
  }
  return () => {
    pollers -= 1;
    if (pollers > 0) return;
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
    window.removeEventListener('focus', refreshOnFocus);
  };
}

/** True while the last restriction check of either Meta agent run failed (the Settings red dot). */
export function useMetaAgentGuardFailed(): boolean {
  const current = useMetaAgentSnapshot();
  useEffect(() => {
    void refreshMetaAgent();
    return startGuardPolling();
  }, []);
  return metaAgentGuardFailures(current.info).length > 0;
}

export function resetMetaAgentStore(): void {
  snapshot = INITIAL;
  inflight = null;
  readGeneration = 0;
  for (const listener of listeners) listener();
}
