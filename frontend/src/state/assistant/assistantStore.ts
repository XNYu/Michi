import { useSyncExternalStore } from 'react';
import {
  AssistantApiError,
  fetchAssistant,
  isAssistantInfo,
  isAssistantMissing,
  type AssistantInfo,
} from '../../services/api/assistant';

/**
 * Window-wide state of the ⌘J assistant: whether the panel is open (kept per
 * window in sessionStorage) and where the assistant's conversation lives.
 * `unsupported` (the backend has no assistant: a 404 or an answer of the
 * wrong shape) is final: the panel never renders and ⌘J does nothing.
 */
export type AssistantStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

export interface AssistantSnapshot {
  open: boolean;
  status: AssistantStatus;
  info: AssistantInfo | null;
  error: string | null;
  /**
   * Bumped by each explicit open (⌘J, the palette, a request). The panel's
   * composer takes focus for these only, not when the panel comes back after
   * a reload or follows a reset.
   */
  focusSeq: number;
}

export const ASSISTANT_PANEL_OPEN_KEY = 'michi:assistant-panel-open';

function readOpen(): boolean {
  try {
    return window.sessionStorage.getItem(ASSISTANT_PANEL_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    if (open) window.sessionStorage.setItem(ASSISTANT_PANEL_OPEN_KEY, '1');
    else window.sessionStorage.removeItem(ASSISTANT_PANEL_OPEN_KEY);
  } catch {
    // Storage unavailable: the panel just doesn't come back after a reload.
  }
}

let snapshot: AssistantSnapshot = { open: readOpen(), status: 'idle', info: null, error: null, focusSeq: 0 };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<AssistantSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  if (patch.open !== undefined) writeOpen(snapshot.open);
  for (const listener of listeners) listener();
}

export function getAssistantSnapshot(): AssistantSnapshot {
  return snapshot;
}

export function subscribeAssistant(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssistantSnapshot(): AssistantSnapshot {
  return useSyncExternalStore(subscribeAssistant, getAssistantSnapshot, getAssistantSnapshot);
}

function getAssistantInfo(): AssistantInfo | null {
  return snapshot.info;
}

/**
 * Just where the assistant's conversation lives. Re-renders only when that
 * changes, not on every open/close or focus bump: every pane reads it.
 */
export function useAssistantInfo(): AssistantInfo | null {
  return useSyncExternalStore(subscribeAssistant, getAssistantInfo, getAssistantInfo);
}

/** Fetch (and on the first call provision) the assistant. Shared while in flight. */
export function loadAssistant(): Promise<void> {
  if (snapshot.status === 'unsupported' || snapshot.status === 'ready') return Promise.resolve();
  if (inflight) return inflight;
  set({ status: 'loading', error: null });
  inflight = fetchAssistant()
    .then((info) => {
      if (!isAssistantInfo(info)) throw new AssistantApiError(200, 'Unexpected assistant response', true);
      set({ status: 'ready', info, error: null });
    })
    .catch((error: unknown) => {
      if (isAssistantMissing(error)) set({ status: 'unsupported', open: false, info: null, error: null });
      else set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Open (or bring the composer focus back to) the panel. False when this backend has no assistant. */
export function openAssistantPanel(): boolean {
  if (snapshot.status === 'unsupported') return false;
  set({ open: true, focusSeq: snapshot.focusSeq + 1 });
  return true;
}

const shownElsewhere = new Set<string>();

/** The open panel is showing this conversation (notifications treat it as in view). */
export function isShownInAssistantPanel(nodeId: string): boolean {
  return (snapshot.open && snapshot.status === 'ready' && snapshot.info?.nodeId === nodeId) || shownElsewhere.has(nodeId);
}

/** Another surface (the Spaces Meta agent window) shows the conversation now; notifications treat it as in view too. */
export function setAssistantShownElsewhere(nodeId: string, shown: boolean): void {
  if (shown) shownElsewhere.add(nodeId);
  else shownElsewhere.delete(nodeId);
}

export function closeAssistantPanel(): void {
  if (snapshot.open) set({ open: false });
}

/** ⌘J. False (nothing happens) when this backend has no assistant. */
export function toggleAssistantPanel(): boolean {
  if (snapshot.status === 'unsupported') return false;
  if (snapshot.open) set({ open: false });
  else set({ open: true, focusSeq: snapshot.focusSeq + 1 });
  return true;
}

/**
 * The assistant started over (Settings fires MICHI_ASSISTANT_RESET_EVENT with
 * the new info): the panel follows the new node.
 */
export function adoptAssistantInfo(info: unknown): void {
  if (snapshot.status === 'unsupported' || !isAssistantInfo(info)) return;
  set({ status: 'ready', info, error: null });
}

/** Test seam. */
export function resetAssistantStoreForTests(patch: Partial<AssistantSnapshot> = {}): void {
  inflight = null;
  snapshot = { open: false, status: 'idle', info: null, error: null, focusSeq: 0, ...patch };
  writeOpen(snapshot.open);
  for (const listener of listeners) listener();
}
