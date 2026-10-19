import type { RemoteServiceRecoveryStatus } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';

export class RemoteServiceRecoveryError extends Error {
  constructor(message: string, readonly recovery: RemoteServiceRecoveryStatus) { super(message); }
}

export async function fetchRemoteServiceRecoveries(signal?: AbortSignal): Promise<RemoteServiceRecoveryStatus[]> {
  const response = await fetch(`${API_BASE_URL}/backend-connections/recovery`, { signal });
  if (!response.ok) throw new Error('Could not check remote recovery.');
  const body = await response.json();
  return Array.isArray(body.recoveries) ? body.recoveries : [];
}

export async function recoverRemoteService(connectionId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/backend-connections/${encodeURIComponent(connectionId)}/recover`, { method: 'POST', signal });
  if (!response.ok) throw new Error('Could not reconnect. Try connecting to this machine again.');
}
