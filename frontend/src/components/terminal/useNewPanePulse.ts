import { useEffect, useState } from 'react';

/**
 * Listens for `michi:new-background-panes` events and returns true when the
 * given nodeId was just opened as a background pane. The flag auto-clears after
 * the sidebar bar pulse animation duration (1.2s = 600ms × 2 cycles).
 * This drives the Layer 1b sidebar bar pulse-once indicator.
 */
export function useNewPanePulse(nodeId: string): boolean {
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeIds: string[] }>).detail;
      if (detail.nodeIds.includes(nodeId)) {
        setIsNew(true);
      }
    };
    window.addEventListener('michi:new-background-panes', handler);
    return () => window.removeEventListener('michi:new-background-panes', handler);
  }, [nodeId]);

  useEffect(() => {
    if (!isNew) return;
    const timer = window.setTimeout(() => setIsNew(false), 1400);
    return () => window.clearTimeout(timer);
  }, [isNew]);

  return isNew;
}
