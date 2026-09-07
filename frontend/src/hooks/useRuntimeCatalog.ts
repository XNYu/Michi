import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchRuntimeCatalog,
  type AgentCapabilities,
  type AgentModelInfo,
  type AgentProviderInfo,
} from '../services/api';

const RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
export const RUNTIME_CATALOG_WAIT_HINT_MS = 8_000;

interface UseRuntimeCatalogOptions {
  enabled: boolean;
  runtime?: string | null;
  provider?: string | null;
}

interface RuntimeCatalogState {
  key: string;
  models: AgentModelInfo[];
  providers: AgentProviderInfo[];
  capabilities: AgentCapabilities | null;
  loading: boolean;
  waiting: boolean;
  error: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message
    ? err.message
    : 'Unable to load runtime catalog';
}

/**
 * Loads the catalog (models + providers + capabilities) for an arbitrary
 * runtime via `/agent/runtime-catalog`. Unlike `useAgentModelCatalog` which
 * uses `/agent/models` (tied to the active global runtime), this hook
 * accepts any runtime id — designed for per-node binding pickers.
 *
 * The backend returns cached data instantly when available and revalidates
 * in the background (方案 A: next open of the picker gets fresh data).
 */
export function useRuntimeCatalog({
  enabled,
  runtime,
  provider,
}: UseRuntimeCatalogOptions) {
  const key = useMemo(() => `${runtime ?? ''}:${provider ?? ''}`, [provider, runtime]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<RuntimeCatalogState>({
    key,
    models: [],
    providers: [],
    capabilities: null,
    loading: false,
    waiting: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !runtime) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    setState((prev) => ({
      key,
      models: prev.key === key ? prev.models : [],
      providers: prev.key === key ? prev.providers : [],
      capabilities: prev.key === key ? prev.capabilities : null,
      loading: true,
      waiting: false,
      error: null,
    }));

    const waitTimer = setTimeout(() => {
      if (!cancelled) setState((prev) => ({ ...prev, waiting: prev.loading }));
    }, RUNTIME_CATALOG_WAIT_HINT_MS);

    const load = async () => {
      try {
        const response = await fetchRuntimeCatalog(runtime, provider ?? undefined);
        if (cancelled) return;
        clearTimeout(waitTimer);
        setState({
          key,
          models: response.models,
          providers: response.providers,
          capabilities: response.capabilities,
          loading: false,
          waiting: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        const message = errorMessage(err);
        const delay = RETRY_DELAYS_MS[failures];
        failures += 1;
        if (delay !== undefined) {
          setState((prev) => ({
            key,
            models: prev.key === key ? prev.models : [],
            providers: prev.key === key ? prev.providers : [],
            capabilities: prev.key === key ? prev.capabilities : null,
            loading: true,
            waiting: prev.waiting,
            error: `${message}. Retrying…`,
          }));
          retryTimer = setTimeout(() => { void load(); }, delay);
          return;
        }
        clearTimeout(waitTimer);
        setState((prev) => ({
          key,
          models: prev.key === key ? prev.models : [],
          providers: prev.key === key ? prev.providers : [],
          capabilities: prev.key === key ? prev.capabilities : null,
          loading: false,
          waiting: false,
          error: message,
        }));
      }
    };

    void load();
    return () => {
      cancelled = true;
      clearTimeout(waitTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [enabled, key, provider, reloadNonce, runtime]);

  const retry = useCallback(() => setReloadNonce((n) => n + 1), []);
  const current = state.key === key
    ? state
    : { key, models: [], providers: [], capabilities: null, loading: false, waiting: false, error: null };

  return {
    ...current,
    loading: enabled && !!runtime && current.loading,
    waiting: enabled && !!runtime && current.waiting,
    retry,
  };
}
