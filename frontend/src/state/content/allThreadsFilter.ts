import { useEffect, useSyncExternalStore } from 'react';
import type { HomeSectionKey } from 'michi-shared';

/**
 * All threads as Spaces opens it: Michi's own conversations, narrowed to one
 * Home section when that section's "View all N" opened it. It lasts until the
 * user leaves the page; it is never saved into a view. Direct navigation
 * opens every native Michi conversation.
 */
export type AllThreadsStateFilter = HomeSectionKey;

export interface SpacesThreadsView {
  state: AllThreadsStateFilter | null;
}

let view: SpacesThreadsView | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function set(next: SpacesThreadsView | null): void {
  if (view === next || (view && next && view.state === next.state)) return;
  view = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const read = () => view;

export function useSpacesThreadsView(): SpacesThreadsView | null {
  return useSyncExternalStore(subscribe, read, read);
}

/** The section filter of the Spaces list; null when unfiltered or opened from elsewhere. */
export function getAllThreadsFilter(): AllThreadsStateFilter | null { return view?.state ?? null; }

const navigateToThreads = () => window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'threads' } }));

/** Opens All threads listing only the Michi conversations in `state`. */
export function openAllThreadsFiltered(state: AllThreadsStateFilter): void {
  set({ state });
  navigateToThreads();
}

/** Marks the next All threads as the Spaces one (every Michi conversation); the caller navigates. */
export function showSpacesAllThreads(): void { set({ state: null }); }

/** The filter chip's ×: every Michi conversation again. */
export function clearAllThreadsFilter(): void { if (view) set({ state: null }); }

/**
 * Leaving All threads ends the Spaces view. The clear waits a microtask and is
 * skipped if the page mounted again meanwhile, so StrictMode's dev remount
 * keeps it.
 */
export function useClearAllThreadsFilterOnLeave(): void {
  useEffect(() => {
    const mounted = ++generation;
    return () => { queueMicrotask(() => { if (generation === mounted) set(null); }); };
  }, []);
}

export function resetAllThreadsViewForTests(): void { view = null; }
