import { useCallback, useEffect, useRef, useState } from 'react';

const RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
interface Options<T> {
  enabled: boolean;
  requestKey: string;
  empty: T;
  load: (refresh: boolean) => Promise<T>;
  complete: (value: T) => boolean;
  errorMessage: string;
  waitHintMs?: number;
}

/** Shared lifecycle only: callers retain their endpoint and completeness semantics. */
export function useCatalogRequest<T>({ enabled, requestKey, empty, load, complete, errorMessage, waitHintMs }: Options<T>) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const refreshRequested = useRef(false);
  const loadedKey = useRef<string | null>(null);
  const [state, setState] = useState({ key: requestKey, value: empty, loading: false, waiting: false, error: null as string | null });
  useEffect(() => {
    if (!enabled) return;
    const refresh = refreshRequested.current;
    refreshRequested.current = false;
    if (!refresh && loadedKey.current === requestKey) return;
    loadedKey.current = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    setState((previous) => ({ key: requestKey, value: previous.key === requestKey ? previous.value : empty, loading: true, waiting: false, error: null }));
    const waitTimer = waitHintMs === undefined ? undefined : setTimeout(() => {
      if (!cancelled) setState((previous) => ({ ...previous, waiting: previous.loading }));
    }, waitHintMs);
    const request = async () => {
      try {
        const value = await load(refresh);
        if (cancelled) return;
        if (complete(value)) loadedKey.current = requestKey;
        clearTimeout(waitTimer);
        setState({ key: requestKey, value, loading: false, waiting: false, error: null });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error && error.message ? error.message : errorMessage;
        const delay = RETRY_DELAYS_MS[failures++];
        setState((previous) => ({ key: requestKey, value: previous.key === requestKey ? previous.value : empty, loading: delay !== undefined, waiting: delay !== undefined && previous.waiting, error: delay === undefined ? message : `${message}. Retrying…` }));
        if (delay !== undefined) retryTimer = setTimeout(() => { void request(); }, delay);
        else clearTimeout(waitTimer);
      }
    };
    void request();
    return () => { cancelled = true; clearTimeout(waitTimer); clearTimeout(retryTimer); };
  }, [enabled, requestKey, reloadNonce, load, complete, empty, errorMessage, waitHintMs]);
  const retry = useCallback(() => { refreshRequested.current = true; setReloadNonce((nonce) => nonce + 1); }, []);
  const current = state.key === requestKey ? state : { key: requestKey, value: empty, loading: enabled, waiting: false, error: null };
  return { ...current, loading: enabled && current.loading, waiting: enabled && current.waiting, retry };
}
