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
