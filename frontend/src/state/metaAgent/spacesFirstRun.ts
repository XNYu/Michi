import { useEffect, useSyncExternalStore } from 'react';
import type { FirstRunProgressDto, WorkspaceHomeSummaryDto } from 'michi-shared';
import {
  fetchSpacesFirstRun,
  retrySpacesFirstRun,
  startSpacesFirstRun,
  type SpacesFirstRunStatus,
} from '../../services/api/spacesHome';
import { notifyPageChanged } from '../pages/pageEvents';
import { spacesSupportsConnection } from './remoteSpaces';

/**
 * The Meta agent's first-time generation per backend connection: each
 * workspace home's first read and the Spaces Home summary after them.
 * Opening Spaces starts it (the route is idempotent); readers poll while
 * something is in progress and the window is visible.
 */

/** `unavailable`: the backend has no first-run routes. */
export type FirstRunLoad = 'loading' | 'ready' | 'unavailable' | 'error';

export interface FirstRunSnapshot {
  load: FirstRunLoad;
  data: SpacesFirstRunStatus | null;
  error: string | null;
  /** The last read got no answer from the backend at all. */
  unreachable: boolean;
  /** Starting was refused because scheduled jobs are off on that backend. */
  schedulerOff: boolean;
  /** Every first read ended while this window watched it. */
  justFinished: boolean;
}

export const FIRST_RUN_POLL_MS = 4_000;
const IN_PROGRESS: ReadonlySet<string> = new Set(['queued', 'reading', 'writing']);
const INITIAL: FirstRunSnapshot = { load: 'loading', data: null, error: null, unreachable: false, schedulerOff: false, justFinished: false };

interface Entry {
  snapshot: FirstRunSnapshot;
  generation: number;
  /** A visit's start in flight: plain re-reads wait for its answer instead of racing it. */
  visiting: Promise<void> | null;
  listeners: Set<() => void>;
  watchers: number;
  timer: number | null;
}

const entries = new Map<string, Entry>();
const finishedListeners = new Set<(connectionId: string, status: SpacesFirstRunStatus) => void>();
let watching = 0;

function entry(connectionId: string): Entry {
  let current = entries.get(connectionId);
  if (!current) {
    current = { snapshot: INITIAL, generation: 0, visiting: null, listeners: new Set(), watchers: 0, timer: null };
    entries.set(connectionId, current);
  }
  return current;
}

export function isFirstRunInProgress(run: FirstRunProgressDto | null | undefined): boolean {
  return !!run && IN_PROGRESS.has(run.state);
}

/**
 * The first run is over: later summaries and first reads of new workspaces are
 * ordinary background work. A backend without `closed` says so by having
 * written a summary, which closes the first run.
 */
export function firstRunClosed(status: SpacesFirstRunStatus | null | undefined): boolean {
  if (!status || status.requestedAt === null) return false;
  return status.closed ?? status.summary.summarizedAt !== null;
}

/** A first read or the Spaces Home summary is still being read or written, and nothing has stopped the runs. */
function homeRunsBusy(status: SpacesFirstRunStatus | null | undefined): boolean {
  if (!status || status.requestedAt === null || status.haltedReason) return false;
  return status.workspaces.some((workspace) => workspace.hiddenAt === null && isFirstRunInProgress(workspace.firstRun))
    || status.summary.state === 'due' || status.summary.state === 'running';
}

/** The first run, the first time only, is still reading or writing. */
export function firstRunActive(status: SpacesFirstRunStatus | null | undefined): boolean {
  return homeRunsBusy(status) && !firstRunClosed(status);
}

/** After the first run: the Spaces Home summary is being rewritten from workspace homes that changed. */
export function spacesHomeUpdating(status: SpacesFirstRunStatus | null | undefined): boolean {
  return !!status && !status.haltedReason && firstRunClosed(status) && status.summary.state === 'running';
}

/** What the pages show, so a change can refresh them. */
function writtenKey(status: SpacesFirstRunStatus): string {
  return [status.summary.state, ...status.workspaces.map((workspace) => `${workspace.workspaceId}:${workspace.firstRun?.state ?? ''}`)].join('|');
}

function publish(connectionId: string, current: Entry, next: FirstRunSnapshot): void {
  const previous = current.snapshot;
  const finished = !!next.data && firstRunActive(previous.data) && !firstRunActive(next.data) && !next.data.haltedReason;
  current.snapshot = finished ? { ...next, justFinished: true } : next;
  for (const listener of current.listeners) listener();
  if (previous.data && next.data && writtenKey(previous.data) !== writtenKey(next.data)) notifyPageChanged({ backendConnectionId: connectionId });
  if (finished && next.data) for (const listener of finishedListeners) listener(connectionId, next.data);
  schedule(connectionId, current);
}

async function read(connectionId: string, call: () => Promise<SpacesFirstRunStatus>, visit = false): Promise<void> {
  const current = entry(connectionId);
  const generation = ++current.generation;
  try {
    const data = await call();
    if (generation !== current.generation) return;
    publish(connectionId, current, {
      load: 'ready', data, error: null, unreachable: false,
      schedulerOff: visit ? false : current.snapshot.schedulerOff,
      justFinished: visit ? false : current.snapshot.justFinished,
    });
  } catch (error) {
    if (generation !== current.generation) return;
    const status = (error as { status?: unknown })?.status;
    if (visit && status === 409) {
      // Scheduled jobs are off there: nothing can run, but the status still reads.
      publish(connectionId, current, { ...current.snapshot, schedulerOff: true, justFinished: false });
      await read(connectionId, () => fetchSpacesFirstRun(connectionId));
      return;
    }
    publish(connectionId, current, {
      ...current.snapshot,
      load: status === 404 ? 'unavailable' : current.snapshot.data ? 'ready' : 'error',
      error: error instanceof Error ? error.message : 'Could not read the Meta agent’s first run',
      unreachable: typeof status !== 'number',
    });
  }
}

export function readSpacesFirstRun(connectionId: string): FirstRunSnapshot {
  return entry(connectionId).snapshot;
}

/** Re-reads the first-run status without starting anything. */
export function refreshSpacesFirstRun(connectionId: string): Promise<void> {
  const visiting = entry(connectionId).visiting;
  return visiting ?? read(connectionId, () => fetchSpacesFirstRun(connectionId));
}

/** Opening Spaces: starts the first run once per connection and wakes pending reads on later visits. A remote connection is never started. */
export function startSpacesFirstRunVisit(connectionId: string): Promise<void> {
  if (!spacesSupportsConnection(connectionId)) return Promise.resolve();
  const current = entry(connectionId);
  const visit = read(connectionId, () => startSpacesFirstRun(connectionId), true).finally(() => {
    if (current.visiting === visit) current.visiting = null;
  });
  current.visiting = visit;
  return visit;
}

/** Queues failed first reads again: one workspace, or every failed one. Not on a remote connection. */
export function retrySpacesFirstRunNow(connectionId: string, workspaceId?: string): Promise<void> {
  if (!spacesSupportsConnection(connectionId)) return Promise.resolve();
  return read(connectionId, () => retrySpacesFirstRun(connectionId, workspaceId));
}

function schedule(connectionId: string, current: Entry): void {
  if (current.timer !== null) { window.clearTimeout(current.timer); current.timer = null; }
  if (current.watchers === 0 || !homeRunsBusy(current.snapshot.data) || document.visibilityState === 'hidden') return;
  current.timer = window.setTimeout(() => {
    current.timer = null;
    void refreshSpacesFirstRun(connectionId);
  }, FIRST_RUN_POLL_MS);
}

function onVisibility(): void {
  for (const [connectionId, current] of entries) {
    if (document.visibilityState === 'visible' && current.watchers > 0 && homeRunsBusy(current.snapshot.data)) void refreshSpacesFirstRun(connectionId);
    else schedule(connectionId, current);
  }
}

function watch(connectionId: string): () => void {
  const current = entry(connectionId);
  current.watchers += 1;
  watching += 1;
  if (watching === 1) document.addEventListener('visibilitychange', onVisibility);
  schedule(connectionId, current);
  return () => {
    current.watchers -= 1;
    watching -= 1;
    if (watching === 0) document.removeEventListener('visibilitychange', onVisibility);
    schedule(connectionId, current);
  };
}

function subscribe(connectionId: string, listener: () => void): () => void {
  const current = entry(connectionId);
  current.listeners.add(listener);
  return () => { current.listeners.delete(listener); };
}

/**
 * The first-run status of one connection, kept fresh while anything is in
 * progress. `start`: this mount is a visit to Spaces, which starts the run.
 */
export function useSpacesFirstRun(connectionId: string, options: { start?: boolean } = {}): FirstRunSnapshot {
  const start = options.start === true;
  const snapshot = useSyncExternalStore(
    (listener) => subscribe(connectionId, listener),
    () => readSpacesFirstRun(connectionId),
    () => readSpacesFirstRun(connectionId),
  );
  useEffect(() => {
    if (start) void startSpacesFirstRunVisit(connectionId);
    else if (readSpacesFirstRun(connectionId).data === null) void refreshSpacesFirstRun(connectionId);
    return watch(connectionId);
  }, [connectionId, start]);
  return snapshot;
}

/** Called each time every first read ends while a window watches. */
export function subscribeFirstRunFinished(listener: (connectionId: string, status: SpacesFirstRunStatus) => void): () => void {
  finishedListeners.add(listener);
  return () => { finishedListeners.delete(listener); };
}

export interface FirstRunProgress {
  /** Conversations read so far over the shown workspaces, and how many there are. */
  read: number;
  total: number;
  /** The workspace being read or written now. */
  current: WorkspaceHomeSummaryDto | null;
  done: number;
  failed: WorkspaceHomeSummaryDto[];
  workspaces: WorkspaceHomeSummaryDto[];
}

export function firstRunProgress(status: SpacesFirstRunStatus | null): FirstRunProgress {
  const workspaces = (status?.workspaces ?? []).filter((workspace) => workspace.hiddenAt === null);
  const progress: FirstRunProgress = { read: 0, total: 0, current: null, done: 0, failed: [], workspaces };
  for (const workspace of workspaces) {
    const run = workspace.firstRun;
    if (!run) continue;
    progress.total += run.total;
    progress.read += run.state === 'done' ? run.total : Math.min(run.readCount, run.total);
    if (run.state === 'done') progress.done += 1;
    if (run.state === 'failed') progress.failed.push(workspace);
    if (!progress.current && (run.state === 'writing' || run.state === 'reading')) progress.current = workspace;
  }
  return progress;
}

/** Whichever copy of one workspace's first run is newer: the home page's own, or the live status. */
export function newerFirstRun(a: FirstRunProgressDto | null | undefined, b: FirstRunProgressDto | null | undefined): FirstRunProgressDto | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

// "New" on a workspace row: the first run wrote its home and it has not been opened since.
const OPENED_KEY = 'michi.spaces-home.opened';
const openedListeners = new Set<() => void>();
let opened: Record<string, number> | null = null;
let openedVersion = 0;

function openedMap(): Record<string, number> {
  if (opened) return opened;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPENED_KEY) || '{}');
    opened = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((pair): pair is [string, number] => typeof pair[1] === 'number'))
      : {};
  } catch { opened = {}; }
  return opened;
}

const openedKey = (connectionId: string, workspaceId: string) => `${connectionId}|${workspaceId}`;

export function isWorkspaceHomeNew(connectionId: string, workspaceId: string, run: FirstRunProgressDto | null | undefined): boolean {
  if (!run || run.state !== 'done' || run.total === 0) return false;
  return (openedMap()[openedKey(connectionId, workspaceId)] ?? 0) < run.updatedAt;
}

export function markWorkspaceHomeOpened(connectionId: string, workspaceId: string, at: number): void {
  const map = openedMap();
  const key = openedKey(connectionId, workspaceId);
  if ((map[key] ?? 0) >= at) return;
  opened = { ...map, [key]: at };
  try { localStorage.setItem(OPENED_KEY, JSON.stringify(opened)); } catch { /* optional UI memory */ }
  openedVersion += 1;
  for (const listener of openedListeners) listener();
}

/** Changes whenever a workspace home is marked opened, so "New" badges re-render. */
export function useWorkspaceHomesOpenedVersion(): number {
  return useSyncExternalStore(
    (listener) => { openedListeners.add(listener); return () => { openedListeners.delete(listener); }; },
    () => openedVersion,
    () => openedVersion,
  );
}

export function resetSpacesFirstRunStore(): void {
  for (const current of entries.values()) if (current.timer !== null) window.clearTimeout(current.timer);
  entries.clear();
  opened = null;
  watching = 0;
  document.removeEventListener('visibilitychange', onVisibility);
}
