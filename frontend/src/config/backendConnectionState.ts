export const BACKEND_CONNECTION_UNAVAILABLE = 'michi:backend-connection-unavailable';
export const BACKEND_CONNECTION_READY = 'michi:backend-connection-ready';
const generations = new Map<string, number>();
const unavailable = new Set<string>();

export function backendConnectionGeneration(connectionId: string): number {
  return generations.get(connectionId) ?? 0;
}

export function backendConnectionUnavailable(connectionId: string): boolean {
  return unavailable.has(connectionId);
}

export function markBackendConnectionReady(connectionId: string): void {
  if (unavailable.delete(connectionId) && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId } }));
  }
}

export function markBackendConnectionUnavailable(connectionId: string, invalidatePendingReads = false): void {
  if (connectionId === 'local' || (unavailable.has(connectionId) && !invalidatePendingReads)) return;
  unavailable.add(connectionId);
  generations.set(connectionId, backendConnectionGeneration(connectionId) + 1);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_UNAVAILABLE, { detail: { connectionId } }));
  }
}
