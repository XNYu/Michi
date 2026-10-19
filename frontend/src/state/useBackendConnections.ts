import { useSyncExternalStore } from 'react';
import { getKnownBackendConnections, subscribeBackendConnections } from '../config/backendConnections';

export function useBackendConnections() {
  return useSyncExternalStore(subscribeBackendConnections, getKnownBackendConnections, getKnownBackendConnections);
}
