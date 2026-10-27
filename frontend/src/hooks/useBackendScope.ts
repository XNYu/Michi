import { useSyncExternalStore } from 'react';
import { activeBackendApiBase, backendApiBase, subscribeBackendConnections } from '../config/backendConnections';
import { BACKEND_CONNECTION_UNAVAILABLE, backendConnectionGeneration } from '../config/backendConnectionState';
import { connectionIdFromApiUrl } from '../config/backendIdentity';

function subscribe(listener: () => void) {
  const unsubscribe = subscribeBackendConnections(listener);
  window.addEventListener(BACKEND_CONNECTION_UNAVAILABLE, listener);
  return () => { unsubscribe(); window.removeEventListener(BACKEND_CONNECTION_UNAVAILABLE, listener); };
}

/** Capture both routing identity and the lifetime of the remote connection. */
export function useBackendScope(connectionId?: string, apiBase?: string) {
  const snapshot = useSyncExternalStore(subscribe, () => {
    const base = apiBase ?? (connectionId === undefined ? activeBackendApiBase() : backendApiBase(connectionId));
    const id = connectionIdFromApiUrl(base);
    return JSON.stringify([base, id, backendConnectionGeneration(id)]);
  });
  const [base, id, generation] = JSON.parse(snapshot) as [string, string, number];
  return { base, connectionId: id, generation, key: snapshot };
}
