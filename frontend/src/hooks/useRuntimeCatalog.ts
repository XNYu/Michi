import { useCallback } from 'react';
import { fetchRuntimeCatalog, type RuntimeCatalogResponse } from '../services/api';
import { useBackendScope } from './useBackendScope';
import { useCatalogRequest } from './useCatalogRequest';

export const RUNTIME_CATALOG_WAIT_HINT_MS = 8_000;
const EMPTY: RuntimeCatalogResponse = { models: [], providers: [], capabilities: null };
const complete = (catalog: RuntimeCatalogResponse) => catalog.capabilities !== null;
interface UseRuntimeCatalogOptions {
  enabled: boolean;
  connectionId?: string;
  runtime?: string | null;
  provider?: string | null;
}

/** Arbitrary runtime catalogs are read-only; null capabilities remain retryable. */
export function useRuntimeCatalog({ enabled, connectionId, runtime, provider }: UseRuntimeCatalogOptions) {
  const scope = useBackendScope(connectionId);
  const load = useCallback((refresh: boolean) => fetchRuntimeCatalog(runtime ?? '', provider ?? undefined, { refresh, connectionId: scope.connectionId }), [runtime, provider, scope.connectionId]);
  const { value, ...state } = useCatalogRequest({
    enabled: enabled && !!runtime,
    requestKey: JSON.stringify([scope.key, runtime ?? '', provider ?? '']),
    empty: EMPTY,
    load,
    complete,
    errorMessage: 'Unable to load runtime catalog',
    waitHintMs: RUNTIME_CATALOG_WAIT_HINT_MS,
  });
  return { ...state, ...value };
}
