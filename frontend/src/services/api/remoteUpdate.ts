import type { RemoteUpdateJob, RemoteUpdateStatus } from 'michi-shared';
import { API_BASE_URL } from '../../config/env';
import { streamRemoteOperation } from './remoteOperation';

export async function checkRemoteVersion(id: string, signal?: AbortSignal): Promise<RemoteUpdateStatus> {
  const response = await fetch(`${API_BASE_URL}/backend-connections/${encodeURIComponent(id)}/version`, {
    // Allow the gateway's 35-second SSH startup plus its 8-second health read.
    signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not check the remote Michi version.');
  return body;
}

/** The gateway's latest update attempt for this machine, or null when it has none. */
export async function fetchRemoteUpdate(id: string, signal?: AbortSignal): Promise<RemoteUpdateJob | null> {
  const response = await fetch(`${API_BASE_URL}/backend-connections/${encodeURIComponent(id)}/update`, {
    // A local read: no SSH is involved.
    signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new Error('Could not check the remote update (HTTP ' + response.status + ').');
  const body = await response.json() as { update?: RemoteUpdateJob | null } | null;
  const update = body?.update;
  return update && typeof update.phase === 'string' && typeof update.message === 'string' ? update : null;
}

export function updateRemoteBackend(id: string, host: string, onProgress: (message: string) => void, signal?: AbortSignal): Promise<RemoteUpdateStatus> {
  return streamRemoteOperation(`${encodeURIComponent(id)}/update`, {}, host, onProgress, signal);
}
