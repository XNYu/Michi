import { useEffect, useState } from 'react';
import { getDeskNow } from '../services/api/desk';

/** Waiting-on-you count for the sidebar. Failures stay quiet so the nav still renders. */
export function useDeskWaitingCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 4000);
      getDeskNow(undefined, controller.signal)
        .then((now) => {
          if (!cancelled) setCount(now.waiting.length + now.more.waiting);
        })
        .catch(() => {})
        .finally(() => window.clearTimeout(timer));
    };
    load();
    window.addEventListener('focus', load);
    window.addEventListener('michi:desk-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
      window.removeEventListener('michi:desk-changed', load);
    };
  }, [enabled]);
  return count;
}
