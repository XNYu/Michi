export const BACKEND_CONNECTION_UNAVAILABLE = 'michi:backend-connection-unavailable';
const generations = new Map<string, number>();
const unavailable = new Set<string>();

export function backendConnectionGeneration(connectionId: string): number {
  return generations.get(connectionId) ?? 0;
}

export function backendConnectionUnavailable(connectionId: string): boolean {
  return unavailable.has(connectionId);
}

export function markBackendConnectionReady(connectionId: string): void {
  unavailable.delete(connectionId);
}

export function markBackendConnectionUnavailable(connectionId: string): void {
  if (connectionId === 'local' || unavailable.has(connectionId)) return;
  unavailable.add(connectionId);
  generations.set(connectionId, backendConnectionGeneration(connectionId) + 1);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_UNAVAILABLE, { detail: { connectionId } }));
  }
}
