import {
  backendApiBase,
  workspaceBackendApiBase,
} from '../../config/backendConnections';
import { configureStreamTransport } from './streamTransport';
import { STREAM_TRANSPORT_PROTOCOL } from 'michi-shared';

// ── Persistence API ──

export async function fetchWorkspaces(connectionId?: string): Promise<unknown[]> {
  const res = await fetch(`${backendApiBase(connectionId)}/workspaces`);
  if (!res.ok) throw new Error(`fetchWorkspaces failed: ${res.status}`);
  const body = await res.json();
  return body.workspaces ?? body;
}

export async function fetchAllWorkspaces(connectionId?: string): Promise<unknown[]> {
  const res = await fetch(`${backendApiBase(connectionId)}/workspaces/all`);
  if (!res.ok) throw new Error(`fetchAllWorkspaces failed: ${res.status}`);
  const body = await res.json();
  return body.workspaces ?? [];
}

/**
 * Lazy-load hydration payload: every workspace's structure + per-node
 * message_count, with NO message bodies. Bodies are fetched per-tree on demand
 * via {@link fetchTreeMessages}. Throws on unreachability (same as
 * fetchAllWorkspaces) so the hydration barrier can retry.
 */
export async function fetchAllWorkspacesMeta(connectionId?: string, signal?: AbortSignal): Promise<unknown[]> {
  const res = await fetch(`${backendApiBase(connectionId)}/workspaces/all?meta=1`, { signal });
  if (!res.ok) throw new Error(`fetchAllWorkspacesMeta failed: ${res.status}`);
  const body = await res.json();
  return body.workspaces ?? [];
}

/** Lazy-load: all message-body rows for one tree. Backend orders by (node, seq). */
export async function fetchTreeMessages(workspaceId: string, treeId: string, connectionId?: string, signal?: AbortSignal): Promise<unknown[]> {
  const res = await fetch(
    `${connectionId ? backendApiBase(connectionId) : workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(workspaceId)}/trees/${encodeURIComponent(treeId)}/messages`,
    { signal },
  );
  if (!res.ok) throw new Error(`fetchTreeMessages failed: ${res.status}`);
  const body = await res.json();
  return body.messages ?? [];
}

export async function fetchWorkspace(id: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${workspaceBackendApiBase(id)}/workspaces/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`fetchWorkspace failed: ${res.status}`);
  return res.json();
}

export interface PersistenceCapabilities {
  protocolVersion: number;
  authoritativeTurnPersistence: boolean;
  durableNodePrerequisite: boolean;
  explicitCommands: boolean;
  backgroundWorkspaceSync: boolean;
  legacySyncAccepted: boolean;
  streamTransport?: string;
}

export function fetchPersistenceCapabilities(connectionId?: string): Promise<PersistenceCapabilities> {
  const base = backendApiBase(connectionId);
  const result = fetch(`${base}/persistence/capabilities`, { signal: AbortSignal.timeout(10_000) }).then(async (res) => {
    if (!res.ok) throw new Error(`fetchPersistenceCapabilities failed: ${res.status}`);
    return res.json() as Promise<PersistenceCapabilities>;
  });
  if (!connectionId || connectionId === 'local') {
    configureStreamTransport(base, result.then((capabilities) => capabilities.streamTransport === STREAM_TRANSPORT_PROTOCOL));
  }
  return result;
}

export interface WorkspaceCommand {
  type: 'workspace.upsert' | 'tree.upsert' | 'tree.delete' | 'node.upsert' | 'node.patch'
    | 'edge.upsert' | 'edge.delete' | 'context.upsert' | 'context.delete';
  payload: Record<string, unknown>;
}

export async function applyWorkspaceCommands(
  workspaceId: string,
  operationId: string,
  commands: readonly WorkspaceCommand[],
): Promise<void> {
  if (commands.length === 0) return;
  const res = await fetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(workspaceId)}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId, commands }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(body.error || `applyWorkspaceCommands failed: ${res.status}`);
  }
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await fetch(`${workspaceBackendApiBase(id)}/workspaces/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteWorkspace failed: ${res.status}`);
}

/**
 * Physically purge every soft-deleted node in a workspace. Called from the
 * Empty Trash UI BEFORE clearing local state. Returns the count of rows
 * actually removed.
 */
export async function emptyWorkspaceTrash(workspaceId: string): Promise<{ ok: boolean; purged: number }> {
  const res = await fetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${workspaceId}/trash/empty`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`emptyWorkspaceTrash failed: ${res.status}`);
  return res.json();
}

/**
 * Physically purge a specific set of nodes from a workspace. Used for the
 * "delete permanently" action on a single trash group. Empty list is a no-op.
 */
export async function purgeWorkspaceNodes(
  workspaceId: string,
  nodeIds: string[],
): Promise<{ ok: boolean; purged: number }> {
  const res = await fetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${workspaceId}/nodes`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds }),
  });
  if (!res.ok) throw new Error(`purgeWorkspaceNodes failed: ${res.status}`);
  return res.json();
}

export async function moveTreeToWorkspace(
  treeId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<{ movedNodes: number; movedEdges: number; droppedEdges: number }> {
  const res = await fetch(`${workspaceBackendApiBase(fromWorkspaceId)}/trees/${encodeURIComponent(treeId)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromWorkspaceId, toWorkspaceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `moveTreeToWorkspace failed: ${res.status}`);
  }
  const body = await res.json();
  return {
    movedNodes: body.movedNodes ?? 0,
    movedEdges: body.movedEdges ?? 0,
    droppedEdges: body.droppedEdges ?? 0,
  };
}
