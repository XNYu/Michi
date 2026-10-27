import { useCallback } from 'react';
import { listAgentModels, type AgentModelsResponse } from '../services/api';
import { useBackendScope } from './useBackendScope';
import { useCatalogRequest } from './useCatalogRequest';

const EMPTY: AgentModelsResponse = { models: [], sanitizedModel: null };
const complete = () => true;
interface UseAgentModelCatalogOptions {
  enabled: boolean;
  connectionId?: string;
  runtime?: string | null;
  provider?: string | null;
}

/** Active-model requests preserve the endpoint's sanitize-and-persist behavior. */
export function useAgentModelCatalog({ enabled, connectionId, runtime, provider }: UseAgentModelCatalogOptions) {
  const scope = useBackendScope(connectionId);
  const load = useCallback((refresh: boolean) => listAgentModels({ runtime: runtime ?? undefined, provider: provider ?? undefined, refresh, connectionId: scope.connectionId }), [runtime, provider, scope.connectionId]);
  const { value, ...state } = useCatalogRequest({
    enabled: enabled && !!runtime,
    requestKey: JSON.stringify([scope.key, runtime ?? '', provider ?? '']),
    empty: EMPTY,
    load,
    complete,
    errorMessage: 'Unable to load models',
  });
  return { ...state, models: value.models };
}
