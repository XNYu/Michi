import { useLayoutEffect, useSyncExternalStore } from 'react';

// Which selection bars are on screen, as a version number that moves each
// time one shows or goes, so the toast can step above them without watching
// the whole document.

let version = 0;
const listeners = new Set<() => void>();

function bump() {
  version += 1;
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Call in every selection bar (Home, All threads, a page's blocks). */
export function useBatchBarPresence(): void {
  useLayoutEffect(() => {
    bump();
    return bump;
  }, []);
}

/** Moves whenever a selection bar shows or goes. */
export function useBatchBarsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}
