import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PageChangeDto, TaskActivity, TaskMark } from 'michi-shared';
import { fetchTaskActivity } from '../../../services/api/taskDatabase';
import { subscribePageChanges } from '../../../state/pages/pageEvents';

/** Tasks opened since the Meta agent changed them, on this computer: a mark goes once its task is opened. */
const SEEN_KEY = 'michi.task-marks-seen.v1';
const SEEN_KEEP_MS = 48 * 60 * 60 * 1000;
/** How often an open board reads the Meta agent's upkeep again; focusing the window and a page change read it too. */
const REFRESH_MS = 60_000;
const NONE: readonly PageChangeDto[] = [];

function readSeen(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  } catch {
    return {};
  }
}

function merged(...sources: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const source of sources) for (const [k, at] of Object.entries(source)) out[k] = Math.max(out[k] ?? 0, at);
  return out;
}

/**
 * What was opened, shared by every board in this window (and kept in step with
 * other windows), so one board's save never drops another's entries. It lives
 * in memory when localStorage is unavailable.
 */
let opened: Record<string, number> | null = null;
const listeners = new Set<() => void>();
const openedNow = (): Record<string, number> => (opened ??= readSeen());
const emit = () => listeners.forEach((listener) => listener());

function subscribeOpened(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== SEEN_KEY) return;
  opened = merged(openedNow(), readSeen());
  emit();
}

function markOpened(key: string, at: number, now: number): void {
  const next = merged(readSeen(), openedNow(), { [key]: at });
  opened = Object.fromEntries(Object.entries(next).filter(([, seenAt]) => now - seenAt < SEEN_KEEP_MS));
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(opened)); } catch { /* optional UI memory: kept in memory */ }
  emit();
}

/** Forgets what this window has loaded, so the next read starts from storage. For tests. */
export function resetOpenedTasks(): void {
  opened = null;
  emit();
}

export interface TaskUpkeepState {
  activity: TaskActivity | null;
  refresh: () => void;
  markOf: (rowId: string) => TaskMark['kind'] | null;
  suggestionsOf: (rowId: string) => readonly PageChangeDto[];
  /** Stable for the life of the board: callers may depend on its identity in effects. */
  seen: (rowId: string) => void;
}

/**
 * What the Meta agent's upkeep did to a task database lately, read again when
 * the database changes, a page change is announced, the window is focused,
 * and every minute. A failed read keeps the last answer.
 */
export function useTaskUpkeep({ connectionId, workspaceId, databaseId, revision, enabled }: {
  connectionId: string;
  workspaceId: string;
  databaseId: string;
  revision: number | null;
  enabled: boolean;
}): TaskUpkeepState {
  // The answer belongs to the database it was read for; another database's line is not an answer.
  const readKey = `${connectionId}\u0000${workspaceId}\u0000${databaseId}`;
  const [read, setRead] = useState<{ key: string; activity: TaskActivity | null } | null>(null);
  const activity = read?.key === readKey ? read.activity : null;
  const [reads, setReads] = useState(0);
  const seenAt = useSyncExternalStore(subscribeOpened, openedNow);
  const refresh = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setRead(null);
      return undefined;
    }
    const controller = new AbortController();
    void fetchTaskActivity({ backendConnectionId: connectionId, workspaceId, databaseId, signal: controller.signal }).then(
      (next) => { if (!controller.signal.aborted) setRead({ key: readKey, activity: next }); },
      () => { /* the board works without it */ },
    );
    return () => controller.abort();
  }, [enabled, connectionId, workspaceId, databaseId, readKey, revision, reads]);

  useEffect(() => {
    if (!enabled) return undefined;
    const stop = subscribePageChanges({ backendConnectionId: connectionId, workspaceId, databaseId }, refresh);
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => {
      stop();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [enabled, connectionId, workspaceId, databaseId, refresh]);

  const marks = useMemo(() => new Map((activity?.marks ?? []).map((mark) => [mark.rowId, mark])), [activity]);
  const suggestions = useMemo(() => {
    const byRow = new Map<string, PageChangeDto[]>();
    for (const change of activity?.suggestions ?? []) {
      if (change.target.kind === 'row') byRow.set(change.target.rowId, [...(byRow.get(change.target.rowId) ?? []), change]);
    }
    return byRow;
  }, [activity]);
  const key = useCallback((rowId: string) => `${connectionId}:${databaseId}:${rowId}`, [connectionId, databaseId]);
  const markOf = useCallback((rowId: string) => {
    const mark = marks.get(rowId);
    return mark && (seenAt[key(rowId)] ?? 0) < mark.at ? mark.kind : null;
  }, [marks, seenAt, key]);
  const suggestionsOf = useCallback((rowId: string) => suggestions.get(rowId) ?? NONE, [suggestions]);

  // `seen` reads the latest marks through a ref so its identity never changes.
  const latest = useRef({ marks, key });
  latest.current = { marks, key };
  const seen = useCallback((rowId: string) => {
    const { marks: current, key: keyOf } = latest.current;
    const mark = current.get(rowId);
    if (!mark) return;
    if ((openedNow()[keyOf(rowId)] ?? 0) >= mark.at) return;
    const now = Date.now();
    markOpened(keyOf(rowId), Math.max(now, mark.at), now);
  }, []);
  return { activity, refresh, markOf, suggestionsOf, seen };
}
