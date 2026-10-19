import { redactRemoteLog } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';

export interface RemoteWorkspaceSummary {
  id: string;
  name: string;
  cwd?: string | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

function parseWorkspace(value: unknown): RemoteWorkspaceSummary {
  if (!value || typeof value !== 'object') throw new Error('The remote workspace list is invalid.');
  const row = value as Record<string, unknown>;
  const validDate = (date: unknown) => date == null || (typeof date === 'number' && Number.isFinite(date));
  if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string'
    || (row.cwd != null && typeof row.cwd !== 'string')
    || !validDate(row.archived_at) || !validDate(row.deleted_at)) {
    throw new Error('The remote workspace list is invalid.');
  }
  return {
    id: row.id, name: row.name, cwd: row.cwd as string | null | undefined,
    archivedAt: row.archived_at as number | null | undefined,
    deletedAt: row.deleted_at as number | null | undefined,
  };
}

/** Read the current inventory through the authenticated proxy, without hydrating or caching it. */
export async function fetchRemoteWorkspaces(connectionId: string, signal?: AbortSignal): Promise<RemoteWorkspaceSummary[]> {
  const deadline = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(`${backendApiBase(connectionId)}/workspaces`, { signal: requestSignal, cache: 'no-store' });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = typeof body?.error === 'string' ? `: ${redactRemoteLog(body.error).slice(0, 2000)}` : '';
      throw new Error(`Could not read remote workspaces (HTTP ${response.status})${detail}`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('workspaces' in body) || !Array.isArray(body.workspaces)) {
      throw new Error('The remote workspace list is invalid.');
    }
    const workspaces = body.workspaces.map(parseWorkspace);
    if (new Set(workspaces.map(workspace => workspace.id)).size !== workspaces.length) {
      throw new Error('The remote workspace list contains duplicate workspace IDs.');
    }
    return workspaces;
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) throw new Error('Reading remote workspaces timed out. Check the connection and try again.');
    throw error;
  }
}
