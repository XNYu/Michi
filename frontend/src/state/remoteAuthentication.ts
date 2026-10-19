import { useSyncExternalStore } from 'react';
import { isRemoteCredentialError, type RemoteAuthenticationTarget } from 'michi-shared';
import { backendConnectionIdForNode, getKnownBackendConnections } from '../config/backendConnections';

export interface RemoteAuthenticationRequest {
  key: string;
  target: RemoteAuthenticationTarget;
  connectionId?: string;
  onComplete?: () => void;
}
let current: RemoteAuthenticationRequest | null = null;
let pending: readonly RemoteAuthenticationRequest[] = [];
const seen = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const getRemoteAuthentication = () => current;

export function requestRemoteAuthentication(request: RemoteAuthenticationRequest, manual = false): void {
  if ((!manual && seen.has(request.key)) || current?.key === request.key) return;
  seen.add(request.key);
  pending = [...pending.filter(item => item.key !== request.key), request];
  if (!current) current = request;
  emit();
}
export function closeRemoteAuthentication(): void { current = null; emit(); }
export function completeRemoteAuthentication(key: string): void {
  if (!pending.some(item => item.key === key) && !seen.has(key)) return;
  pending = pending.filter(item => item.key !== key); seen.delete(key); emit();
}
export function usePendingRemoteAuthentications() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => pending, () => pending);
}
export function useRemoteAuthentication() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, getRemoteAuthentication, getRemoteAuthentication);
}

export function authenticationTargetForHost(raw: string): RemoteAuthenticationTarget {
  const host = raw.trim().replace(/^ssh\s+/, '');
  const at = host.indexOf('@');
  return { scope: 'local', host: at >= 0 ? host.slice(at + 1) : host, ...(at >= 0 ? { user: host.slice(0, at) } : {}) };
}

/** Only credential errors, never assistant text or tool output, open this UI. */
export function reportRemoteCredentialError(nodeId: string, message: string): boolean {
  if (!isRemoteCredentialError(message)) return false;
  const id = backendConnectionIdForNode(nodeId);
  const connection = getKnownBackendConnections().find(item => item.id === id && item.transport === 'ssh');
  if (!connection?.sshHost) return false;
  requestRemoteAuthentication({ key: `runtime:${id}`, connectionId: id,
    target: { scope: 'remote', host: connection.sshHost, user: connection.sshUser, port: connection.sshPort } });
  return true;
}

/** A completed remote turn also covers sign-in performed outside Michi. */
export function reportRemoteRuntimeReady(nodeId: string): void {
  completeRemoteAuthentication(`runtime:${backendConnectionIdForNode(nodeId)}`);
}
