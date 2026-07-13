import { useCallback, useEffect, useMemo, useState } from 'react';
import { listAgentModels, type AgentModelInfo } from '../services/api';

const RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

interface UseAgentModelCatalogOptions {
  enabled: boolean;
  runtime?: string | null;
  provider?: string | null;
}

interface AgentModelCatalogState {
  key: string;
  models: AgentModelInfo[];
  loading: boolean;
  error: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message
    ? err.message
    : 'Unable to load models';
}

/**
 * Loads the active runtime's model catalog with bounded automatic retries.
 * Requests are cancelled logically on runtime/provider changes so a slow old
 * response can never overwrite the newly-selected runtime's catalog.
 */
export function useAgentModelCatalog({
  enabled,
  runtime,
  provider,
}: UseAgentModelCatalogOptions) {
  const key = useMemo(() => `${runtime ?? ''}:${provider ?? ''}`, [provider, runtime]);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<AgentModelCatalogState>({
    key,
    models: [],
    loading: false,
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
      loading: true,
      error: null,
    }));

    const load = async () => {
      try {
        const response = await listAgentModels({ provider: provider ?? undefined });
        if (cancelled) return;
        setState({ key, models: response.models, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        const message = errorMessage(err);
        const delay = RETRY_DELAYS_MS[failures];
        failures += 1;
        if (delay !== undefined) {
          setState((prev) => ({
            key,
            models: prev.key === key ? prev.models : [],
            loading: true,
            error: `${message}. Retrying…`,
          }));
          retryTimer = setTimeout(() => { void load(); }, delay);
          return;
        }
        setState((prev) => ({
          key,
          models: prev.key === key ? prev.models : [],
          loading: false,
          error: message,
        }));
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [enabled, key, provider, reloadNonce, runtime]);

  const retry = useCallback(() => setReloadNonce((n) => n + 1), []);
  const current = state.key === key
    ? state
    : { key, models: [], loading: false, error: null };

  return { ...current, retry };
}
