import React from 'react';
import { fetchAgentStatus, fetchRuntimeCatalog } from '../../../services/api/agentRuntime';
import { useBackendScope } from '../../../hooks/useBackendScope';
import { catalogKey, type RuntimeFieldCatalog } from './AgentRuntimeProfileFields';

/** Advisory editor catalogs follow the edited resource, including remote reconnects. */
export function useRuntimeFieldCatalog(connectionId?: string): RuntimeFieldCatalog | null {
  const scope = useBackendScope(connectionId);
  const lifetime = React.useMemo(() => ({ key: scope.key, disposed: false, pending: new Set<string>(), loaded: new Set<string>(), failed: new Set<string>(), timers: new Set<ReturnType<typeof setTimeout>>() }), [scope.key]);
  const [state, setState] = React.useState<{ key: string; catalog: Omit<RuntimeFieldCatalog, 'request'> | null }>({ key: scope.key, catalog: null });
  React.useEffect(() => {
    const controller = new AbortController();
    lifetime.disposed = false;
    fetchAgentStatus(scope.connectionId, controller.signal)
      .then((status) => {
        if (!lifetime.disposed) setState({ key: scope.key, catalog: { runtimes: status.availableRuntimes ?? [], providersFor: {}, modelsFor: {}, capabilitiesFor: {} } });
      })
      .catch(() => { if (!lifetime.disposed) setState({ key: scope.key, catalog: null }); });
    return () => { lifetime.disposed = true; controller.abort(); lifetime.timers.forEach(clearTimeout); };
  }, [scope.key, scope.connectionId, lifetime]);
  const request = React.useCallback((runtimeId: string, providerId: string) => {
    const key = catalogKey(runtimeId, providerId);
    if (!runtimeId || lifetime.disposed || lifetime.pending.has(key) || lifetime.loaded.has(key) || lifetime.failed.has(key)) return;
    lifetime.pending.add(key);
    const load = async (attempt: number) => {
      try {
        const response = await fetchRuntimeCatalog(runtimeId, providerId || undefined, { connectionId: scope.connectionId });
        if (lifetime.disposed) return;
        if (!response.capabilities) throw new Error('Runtime catalog is not ready');
        const capabilities = response.capabilities;
        lifetime.loaded.add(key);
        setState((current) => current.key !== scope.key || !current.catalog ? current : ({ key: scope.key, catalog: {
          ...current.catalog,
          providersFor: { ...current.catalog.providersFor, [runtimeId]: response.providers },
          modelsFor: { ...current.catalog.modelsFor, [key]: response.models },
          capabilitiesFor: { ...current.catalog.capabilitiesFor, [runtimeId]: capabilities },
          errorsFor: { ...current.catalog.errorsFor, [key]: undefined },
        } }));
      } catch (error) {
        const delay = [500, 1_000, 2_000][attempt];
        if (!lifetime.disposed && delay !== undefined) {
          const timer = setTimeout(() => { lifetime.timers.delete(timer); void load(attempt + 1); }, delay);
          lifetime.timers.add(timer);
          return;
        }
        if (!lifetime.disposed) {
          lifetime.failed.add(key);
          setState((current) => current.key !== scope.key || !current.catalog ? current : ({ key: scope.key, catalog: { ...current.catalog, errorsFor: { ...current.catalog.errorsFor, [key]: error instanceof Error ? error.message : 'Unable to load runtime options' } } }));
        }
      }
      lifetime.pending.delete(key);
    };
    void load(0);
  }, [scope.key, scope.connectionId, lifetime]);
  const retry = React.useCallback((runtimeId: string, providerId: string) => {
    lifetime.failed.delete(catalogKey(runtimeId, providerId));
    request(runtimeId, providerId);
  }, [lifetime, request]);
  return React.useMemo(() => state.key === scope.key && state.catalog ? { ...state.catalog, request, retry } : null, [state, scope.key, request, retry]);
}
