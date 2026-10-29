import { useSyncExternalStore } from 'react';
import {
  AssistantApiError,
  fetchScheduleAssistant,
  isAssistantInfo,
  isAssistantMissing,
  type AssistantInfo,
} from '../../services/api/assistant';
import type { AssistantStatus } from './assistantStore';
import type { AssistantConversationSource } from './assistantSource';

/**
 * Window-wide state of the Scheduled page's "Create with agent" conversation:
 * where it lives and whether this backend has one. `unsupported` (a 404 or an
 * answer of the wrong shape: an older backend) is final, and the page then
 * shows no button. The Spaces assistant's store (assistantStore.ts) is
 * separate: the two windows never show each other's conversation.
 */
export interface ScheduleAssistantSnapshot {
  status: AssistantStatus;
  info: AssistantInfo | null;
  error: string | null;
}

const INITIAL: ScheduleAssistantSnapshot = { status: 'idle', info: null, error: null };

let snapshot: ScheduleAssistantSnapshot = INITIAL;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<ScheduleAssistantSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function getScheduleAssistantSnapshot(): ScheduleAssistantSnapshot {
  return snapshot;
}

export function subscribeScheduleAssistant(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useScheduleAssistant(): ScheduleAssistantSnapshot {
  return useSyncExternalStore(subscribeScheduleAssistant, getScheduleAssistantSnapshot, getScheduleAssistantSnapshot);
}

/** Fetch (and on the first call provision) the conversation. Shared while in flight. */
export function loadScheduleAssistant(): Promise<void> {
  if (snapshot.status === 'unsupported' || snapshot.status === 'ready') return Promise.resolve();
  if (inflight) return inflight;
  set({ status: 'loading', error: null });
  inflight = fetchScheduleAssistant()
    .then((info) => {
      if (!isAssistantInfo(info)) throw new AssistantApiError(200, 'Unexpected assistant response', true);
      set({ status: 'ready', info, error: null });
    })
    .catch((error: unknown) => {
      if (isAssistantMissing(error)) set({ status: 'unsupported', info: null, error: null });
      else set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** The window started over, or the backend answered with its conversation's current settings. */
export function adoptScheduleAssistantInfo(info: unknown): void {
  if (snapshot.status === 'unsupported' || !isAssistantInfo(info)) return;
  set({ status: 'ready', info, error: null });
}

/** The conversation source TPane uses for this window's composer. */
export function scheduleAssistantSource(info: AssistantInfo | null): AssistantConversationSource {
  return {
    info,
    current: () => snapshot.info,
    adopt: adoptScheduleAssistantInfo,
    refetch: fetchScheduleAssistant,
  };
}

let openRequested = false;
const openListeners = new Set<() => void>();

/**
 * A notification or the "agent is asking" bar points at `nodeId`: when it is
 * this window's conversation, go to the Scheduled page and open the window
 * there (not the ⌘J panel, which shows the Spaces conversation). False for
 * any other node.
 */
export function revealScheduleAssistant(nodeId: string): boolean {
  if (!nodeId || snapshot.info?.nodeId !== nodeId) return false;
  openRequested = true;
  window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'scheduled' } }));
  for (const listener of openListeners) listener();
  return true;
}

/** The window consumes a pending reveal once, when it is mounted or when one arrives. */
export function takeScheduleAssistantOpenRequest(): boolean {
  const requested = openRequested;
  openRequested = false;
  return requested;
}

export function subscribeScheduleAssistantOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

/** Test seam. */
export function resetScheduleAssistantStoreForTests(patch: Partial<ScheduleAssistantSnapshot> = {}): void {
  inflight = null;
  openRequested = false;
  snapshot = { ...INITIAL, ...patch };
  for (const listener of listeners) listener();
}
