import { API_BASE_URL } from './env';
import { remoteEntityIdentity } from './backendIdentity';

export const LOCAL_BACKEND_CONNECTION_ID = 'local';

export type BackendConnectionTransport = 'direct' | 'ssh';

export interface BackendConnectionSummary {
  id: string;
  name: string;
  transport: BackendConnectionTransport;
  apiUrl?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number;
  remotePort?: number;
  tunnelStatus?: 'disconnected' | 'connecting' | 'connected' | 'error';
  tunnelError?: string;
  hasToken: boolean;
  createdAt: number;
  updatedAt: number;
}

export const LOCAL_BACKEND_CONNECTION: BackendConnectionSummary = {
  id: LOCAL_BACKEND_CONNECTION_ID,
  name: 'Local',
  transport: 'direct',
  apiUrl: API_BASE_URL,
  hasToken: false,
  createdAt: 0,
  updatedAt: 0,
};

let knownConnections: BackendConnectionSummary[] = [LOCAL_BACKEND_CONNECTION];
const connectionListeners = new Set<() => void>();
let activeConnectionId = LOCAL_BACKEND_CONNECTION_ID;
const workspaceConnections = new Map<string, string>();
const nodeConnections = new Map<string, string>();

export function setKnownBackendConnections(connections: BackendConnectionSummary[]): void {
  knownConnections = [LOCAL_BACKEND_CONNECTION, ...connections.filter((connection) => connection.id !== LOCAL_BACKEND_CONNECTION_ID)];
  connectionListeners.forEach(listener => listener());
}

export function getKnownBackendConnections(): BackendConnectionSummary[] {
  return knownConnections;
}

export function subscribeBackendConnections(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => { connectionListeners.delete(listener); };
}

export function setActiveBackendConnectionId(connectionId: string | undefined): void {
  const next = connectionId || LOCAL_BACKEND_CONNECTION_ID;
  if (activeConnectionId === next) return;
  activeConnectionId = next;
  // ChatProvider records the active identity during render. Notify after that
  // render so subscribed pickers do not update another component mid-render.
  queueMicrotask(() => connectionListeners.forEach(listener => listener()));
}

export function indexBackendProjects(
  projects: Array<{ id: string; backendConnectionId?: string; chatIds: string[] }>,
): void {
  workspaceConnections.clear();
  nodeConnections.clear();
  for (const project of projects) {
    const identity = remoteEntityIdentity(project.id);
    if (identity && project.backendConnectionId && identity.connectionId !== project.backendConnectionId) {
      throw new Error('Workspace belongs to a different backend connection');
    }
    const connectionId = identity?.connectionId ?? project.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID;
    workspaceConnections.set(project.id, connectionId);
    for (const nodeId of project.chatIds) {
      const nodeIdentity = remoteEntityIdentity(nodeId);
      if (nodeIdentity && nodeIdentity.connectionId !== connectionId) throw new Error('Node belongs to a different backend connection');
      nodeConnections.set(nodeId, connectionId);
    }
  }
}

export function backendConnectionIdForWorkspace(workspaceId: string): string {
  return remoteEntityIdentity(workspaceId)?.connectionId ?? workspaceConnections.get(workspaceId) ?? LOCAL_BACKEND_CONNECTION_ID;
}

export function backendConnectionIdForNode(nodeId: string): string {
  return remoteEntityIdentity(nodeId)?.connectionId ?? nodeConnections.get(nodeId) ?? LOCAL_BACKEND_CONNECTION_ID;
}

export function backendApiBase(connectionId = LOCAL_BACKEND_CONNECTION_ID): string {
  if (!connectionId || connectionId === LOCAL_BACKEND_CONNECTION_ID) return API_BASE_URL;
  return `${API_BASE_URL}/backend-connections/${encodeURIComponent(connectionId)}/proxy`;
}

export function activeBackendApiBase(): string {
  return backendApiBase(activeConnectionId);
}

export function workspaceBackendApiBase(workspaceId: string): string {
  return backendApiBase(backendConnectionIdForWorkspace(workspaceId));
}

export function nodeBackendApiBase(nodeId: string): string {
  return backendApiBase(backendConnectionIdForNode(nodeId));
}
