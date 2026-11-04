import { toast } from 'sonner';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { MemoryChangedEvent, MemoryRecord } from 'michi-shared';
import { deleteMemory, isMemoryNotFound, isMemoryUnavailable, listMemories, subscribeMemoryChanges } from '../../services/api/memories';
import { SseHttpError } from '../../services/api/sseParser';

/**
 * Michi Memory's notices, kept the way the Meta agent's tool approvals are
 * (useMetaAgent.ts): a toast for a change that needs the user, and a count
 * the Settings rail button and Settings › Memory show. Changes arrive on the
 * backend's memory change feed (GET /api/memories/changes/stream).
 *
 * A memory an agent saved shows "Remembered: …" with Undo; one that waits
 * for approval shows a notice that opens Settings › Memory. What Settings
 * itself just changed shows no toast. Notices never move focus, open a pane
 * or switch the workspace or thread.
 */

export interface MemoryBadgeSnapshot {
  /** Memories waiting for approval, up to PENDING_LIMIT. */
  pendingCount: number;
  /** More than PENDING_LIMIT are waiting. */
  pendingMore: boolean;
}

const INITIAL: MemoryBadgeSnapshot = { pendingCount: 0, pendingMore: false };
const PENDING_LIMIT = 200;
/** How long after Settings changed a memory its own change events stay quiet. */
const SELF_WINDOW_MS = 10_000;
/** Longest a change waits for a Settings addition in flight to name its memory. */
const HOLD_MAX_MS = 10_000;
const REFRESH_DEBOUNCE_MS = 200;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** A feed that stayed open this long starts its reconnect delay over. */
const STABLE_MS = 30_000;
const PREVIEW_CHARS = 120;
const NOTIFIED_LIMIT = 1_000;
const PENDING_TOAST_ID = 'memory:pending';

let snapshot = INITIAL;
const listeners = new Set<() => void>();
const changeListeners = new Set<(event: MemoryChangedEvent) => void>();

// Mutations Settings made: memory id → until when its events stay quiet.
const selfIds = new Map<string, number>();
// Settings additions in flight; their ids are known only once they answer.
let creating = 0;
let held: MemoryChangedEvent[] = [];
let holdTimer: ReturnType<typeof setTimeout> | null = null;
// Memories a toast already announced (a feed reconnect can repeat nothing, but a mock or replay could).
const notified = new Set<string>();
let pendingNotices = 0;
let reviewHandler: (() => void) | null = null;

let refreshGeneration = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

let feedUsers = 0;
let stopFeed: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;
let openedAt = 0;
let feedState: 'idle' | 'open' | 'unavailable' = 'idle';

function publish(next: MemoryBadgeSnapshot): void {
  if (next.pendingCount === snapshot.pendingCount && next.pendingMore === snapshot.pendingMore) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function readMemoryBadge(): MemoryBadgeSnapshot {
  return snapshot;
}

/** Settings › Memory read the pending list itself; the badge shows its length. */
export function notePendingMemories(count: number, more = false): void {
  refreshGeneration += 1;
  publish({ pendingCount: Math.max(0, count), pendingMore: more });
}

/** Read how many memories wait for approval. A backend without Memory shows none. */
export async function refreshMemoryPendingCount(): Promise<void> {
  const mine = ++refreshGeneration;
  try {
    const page = await listMemories({ status: ['pending'], limit: PENDING_LIMIT });
    if (mine === refreshGeneration) publish({ pendingCount: page.items.length, pendingMore: page.nextCursor !== null });
  } catch (error) {
    if (mine === refreshGeneration && isMemoryUnavailable(error)) publish(INITIAL);
  }
}

function schedulePendingRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshMemoryPendingCount();
  }, REFRESH_DEBOUNCE_MS);
}

// ── changes Settings makes ─────────────────────────────────────────────────

function isSelf(memoryId: string): boolean {
  const until = selfIds.get(memoryId);
  if (until === undefined) return false;
  if (until >= Date.now()) return true;
  selfIds.delete(memoryId);
  return false;
}

function markSelf(memoryId: string): void {
  const now = Date.now();
  for (const [id, until] of selfIds) if (until < now) selfIds.delete(id);
  selfIds.set(memoryId, now + SELF_WINDOW_MS);
}

/** Run a change Settings makes to one memory; the change events it causes show no toast. */
export async function runSelfMutation<T>(memoryId: string, action: () => Promise<T>): Promise<T> {
  markSelf(memoryId);
  try {
    return await action();
  } finally {
    markSelf(memoryId);
    schedulePendingRefresh();
  }
}

/**
 * Add a memory from Settings. Its id is unknown until the backend answers,
 * and the feed may announce it first, so new memories wait for the answer:
 * the one Settings added shows no toast, any other then shows as usual.
 */
export async function runSelfCreate(action: () => Promise<MemoryRecord>): Promise<MemoryRecord> {
  creating += 1;
  try {
    const record = await action();
    markSelf(record.id);
    return record;
  } finally {
    creating -= 1;
    if (creating === 0) flushHeld();
    schedulePendingRefresh();
  }
}

function flushHeld(): void {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  const events = held;
  held = [];
  for (const event of events) announce(event);
}

// ── toasts ─────────────────────────────────────────────────────────────────

function preview(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

const rememberedToastId = (memoryId: string) => `memory:${memoryId}`;

function review(): void {
  reviewHandler?.();
}

function reviewAction() {
  return reviewHandler ? { action: { label: 'Review', onClick: review } } : {};
}

/** Undo from the "Remembered" toast: delete the memory the agent just saved. */
export async function undoRememberedMemory(memoryId: string): Promise<void> {
  try {
    await runSelfMutation(memoryId, () => deleteMemory(memoryId));
    toast.success('Memory removed');
  } catch (error) {
    if (isMemoryNotFound(error)) toast('That memory was already removed');
    else toast.error(`Couldn’t remove the memory: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

function announce(event: MemoryChangedEvent): void {
  if (isSelf(event.memoryId) || notified.has(event.memoryId)) return;
  notified.add(event.memoryId);
  if (notified.size > NOTIFIED_LIMIT) notified.delete(notified.values().next().value as string);
  const text = preview(event.body);
  if (event.status === 'pending') {
    pendingNotices += 1;
    const reset = () => { pendingNotices = 0; };
    toast(pendingNotices === 1 ? '1 memory is waiting for your confirmation' : `${pendingNotices} memories are waiting for your confirmation`, {
      id: PENDING_TOAST_ID,
      description: pendingNotices === 1 ? text : 'Review them in Settings › Memory.',
      duration: 12_000,
      onDismiss: reset,
      onAutoClose: reset,
      ...reviewAction(),
    });
    return;
  }
  if (event.status !== 'active') return;
  // A correction replaced an older memory, which deleting it would not bring back.
  if (event.supersedesId) {
    toast(`Memory updated: ${text}`, { id: rememberedToastId(event.memoryId), duration: 10_000, ...reviewAction() });
    return;
  }
  toast(`Remembered: ${text}`, {
    id: rememberedToastId(event.memoryId),
    duration: 10_000,
    action: { label: 'Undo', onClick: () => { void undoRememberedMemory(event.memoryId); } },
  });
}

function receive(event: MemoryChangedEvent): void {
  schedulePendingRefresh();
  for (const listener of [...changeListeners]) {
    try { listener(event); } catch { /* one view's failure must not stop the others */ }
  }
  if (event.action === 'deleted' || event.action === 'rejected') {
    toast.dismiss(rememberedToastId(event.memoryId));
    return;
  }
  if (event.action !== 'created') return;
  if (creating > 0 && !isSelf(event.memoryId)) {
    held.push(event);
    holdTimer ??= setTimeout(flushHeld, HOLD_MAX_MS);
    return;
  }
  announce(event);
}

/** Called with every memory change the feed reports (Settings refreshes its lists). Returns unsubscribe. */
export function onMemoryChanged(listener: (event: MemoryChangedEvent) => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

// ── the feed ───────────────────────────────────────────────────────────────

function connect(): void {
  if (stopFeed || feedUsers === 0 || feedState === 'unavailable') return;
  stopFeed = subscribeMemoryChanges({
    onOpen: () => {
      feedState = 'open';
      openedAt = Date.now();
      void refreshMemoryPendingCount();
    },
    onEvent: receive,
    onDisconnect: (error) => {
      stopFeed = null;
      const status = error instanceof SseHttpError ? error.status : null;
      // No feed on this backend (or no access to it): stay with focus refreshes.
      if (status === 401 || status === 403 || status === 404) { feedState = 'unavailable'; return; }
      if (feedState === 'open' && Date.now() - openedAt >= STABLE_MS) failures = 0;
      feedState = 'idle';
      failures += 1;
      if (feedUsers === 0) return;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(failures - 1, 10));
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    },
  });
}

const refreshOnFocus = () => { void refreshMemoryPendingCount(); };

function startFeed(): () => void {
  feedUsers += 1;
  if (feedUsers === 1) {
    void refreshMemoryPendingCount();
    connect();
    window.addEventListener('focus', refreshOnFocus);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    feedUsers -= 1;
    if (feedUsers > 0) return;
    window.removeEventListener('focus', refreshOnFocus);
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopFeed?.();
    stopFeed = null;
    if (feedState === 'open') feedState = 'idle';
  };
}

/**
 * Listen for memory changes while mounted (once the workspaces have loaded):
 * show their toasts and keep the pending count fresh. `onReview` opens
 * Settings › Memory from a toast.
 */
export function useMemoryNotifications(onReview: () => void): void {
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  useEffect(() => {
    const handler = () => reviewRef.current();
    reviewHandler = handler;
    const stop = startFeed();
    return () => {
      stop();
      if (reviewHandler === handler) reviewHandler = null;
    };
  }, []);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The pending count as last read, for the Settings rail button and Settings › Memory. */
export function useMemoryBadge(): MemoryBadgeSnapshot {
  return useSyncExternalStore(subscribe, readMemoryBadge, readMemoryBadge);
}

/**
 * Forget every notice, count and feed between test cases.
 * @testonly
 */
export function resetMemoryNotifications(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (holdTimer !== null) clearTimeout(holdTimer);
  refreshTimer = null;
  reconnectTimer = null;
  holdTimer = null;
  stopFeed?.();
  stopFeed = null;
  feedUsers = 0;
  feedState = 'idle';
  failures = 0;
  openedAt = 0;
  selfIds.clear();
  creating = 0;
  held = [];
  notified.clear();
  pendingNotices = 0;
  reviewHandler = null;
  refreshGeneration = 0;
  changeListeners.clear();
  if (typeof window !== 'undefined') window.removeEventListener('focus', refreshOnFocus);
  snapshot = INITIAL;
  for (const listener of listeners) listener();
}
