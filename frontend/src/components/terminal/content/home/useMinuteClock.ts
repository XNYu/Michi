import { useEffect, useState } from 'react';

export const MICHI_HOME_CLOCK_MS = 60_000;

/**
 * `Date.now()` that moves on once a minute while `enabled`, so relative
 * times ("3h", "last looked 2h ago") stay true on a Home left open.
 */
export function useMinuteClock(enabled: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setClock(Date.now());
    const id = window.setInterval(() => setClock(Date.now()), MICHI_HOME_CLOCK_MS);
    return () => window.clearInterval(id);
  }, [enabled]);
  return clock;
}
