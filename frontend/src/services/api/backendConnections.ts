import { API_BASE_URL } from '../../config/env';
import type {
  BackendConnectionSummary,
  BackendConnectionTransport,
} from '../../config/backendConnections';

export interface BackendConnectionInput {
  id?: string;
  name: string;
  transport: BackendConnectionTransport;
  apiUrl?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number | null;
  remotePort?: number | null;
  token?: string;
}

export async function listBackendConnections(): Promise<BackendConnectionSummary[]> {
  const res = await fetch(`${API_BASE_URL}/backend-connections`);
  if (!res.ok) throw new Error(`listBackendConnections failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.connections) ? body.connections : [];
}

export async function testBackendConnection(
  input: BackendConnectionInput,
): Promise<{ ok: boolean; apiUrl?: string; serverId?: string; error?: string }> {
  const res = await fetch(`${API_BASE_URL}/backend-connections/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({ ok: false, error: `status ${res.status}` }));
  return body;
}

export async function saveBackendConnection(input: BackendConnectionInput): Promise<BackendConnectionSummary> {
  const res = await fetch(`${API_BASE_URL}/backend-connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
  if (!res.ok) throw new Error(body.error || `saveBackendConnection failed: ${res.status}`);
  return body.connection;
}

export async function deleteBackendConnection(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/backend-connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(body.error || `deleteBackendConnection failed: ${res.status}`);
  }
}

export type RemoteSetupResult =
  | { kind: 'install_required'; host: string }
  | { kind: 'connected'; connection: BackendConnectionSummary; home: string; runtimes: string[] };

export async function connectRemoteDesktop(
  host: string, install: boolean, onProgress: (message: string) => void, signal?: AbortSignal,
): Promise<RemoteSetupResult> {
  const response = await fetch(`${API_BASE_URL}/backend-connections/connect-ssh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, install }), signal,
  });
  if (!response.ok || !response.body) throw new Error('Could not start the remote connection.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let result: RemoteSetupResult | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress') onProgress(event.message);
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'result') result = event.result;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) consume(line);
      if (done) { consume(pending); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!result) throw new Error('The remote connection ended before setup completed.');
  return result;
}

export interface RemoteDirectory {
  path: string; parent: string | null; entries: { name: string; path: string }[];
}

export async function browseRemoteDirectory(connectionId: string, path = '~', signal?: AbortSignal): Promise<RemoteDirectory> {
  const response = await fetch(`${API_BASE_URL}/backend-connections/${encodeURIComponent(connectionId)}/directories?path=${encodeURIComponent(path)}`, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not read the remote folder.');
  return body;
}
