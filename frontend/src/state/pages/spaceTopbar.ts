import { useSyncExternalStore } from 'react';

/**
 * What the open Space page tells the topbar: its title for the breadcrumb and
 * its "Open beside chat" action. Null while no Space page is open.
 */
export interface SpaceTopbarState {
  title: string;
  onOpenBeside: () => void;
}

let current: SpaceTopbarState | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = () => current;

export function publishSpaceTopbar(next: SpaceTopbarState | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function useSpaceTopbar(): SpaceTopbarState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
