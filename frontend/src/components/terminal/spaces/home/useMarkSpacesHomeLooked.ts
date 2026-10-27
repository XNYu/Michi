import { useEffect, useRef } from 'react';
import { markSpacesHomeLooked } from '../../../../services/api/spacesHome';

let homeGeneration = 0;

/**
 * Leaving the Spaces Home is what counts as having looked: Just done lists
 * what completed after that. Only a Home that showed its sections counts.
 * The mark waits a microtask and is dropped if the Home mounted again
 * meanwhile, so StrictMode's dev unmount/remount on first render doesn't
 * reset the window while the user is still looking at it.
 */
export function useMarkSpacesHomeLookedOnLeave(connectionId: string, shown: boolean): void {
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const generation = ++homeGeneration;
    return () => {
      if (!shownRef.current) return;
      queueMicrotask(() => {
        if (homeGeneration === generation) void markSpacesHomeLooked(connectionId).catch(() => undefined);
      });
    };
  }, [connectionId]);
}
