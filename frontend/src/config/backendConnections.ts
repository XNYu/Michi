import { API_BASE_URL } from './env';

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

let remoteConnections: BackendConnectionSummary[] = [];
let activeConnectionId = LOCAL_BACKEND_CONNECTION_ID;
const workspaceConnections = new Map<string, string>();
const nodeConnections = new Map<string, string>();

export function setKnownBackendConnections(connections: BackendConnectionSummary[]): void {
  remoteConnections = connections.filter((connection) => connection.id !== LOCAL_BACKEND_CONNECTION_ID);
}

export function getKnownBackendConnections(): BackendConnectionSummary[] {
  return [LOCAL_BACKEND_CONNECTION, ...remoteConnections];
}

export function setActiveBackendConnectionId(connectionId: string | undefined): void {
  activeConnectionId = connectionId || LOCAL_BACKEND_CONNECTION_ID;
}

export function indexBackendProjects(
  projects: Array<{ id: string; backendConnectionId?: string; chatIds: string[] }>,
): void {
  workspaceConnections.clear();
  nodeConnections.clear();
  for (const project of projects) {
    const connectionId = project.backendConnectionId || LOCAL_BACKEND_CONNECTION_ID;
    workspaceConnections.set(project.id, connectionId);
    for (const nodeId of project.chatIds) nodeConnections.set(nodeId, connectionId);
  }
}

export function backendConnectionIdForWorkspace(workspaceId: string): string {
  return workspaceConnections.get(workspaceId) ?? LOCAL_BACKEND_CONNECTION_ID;
}

export function backendConnectionIdForNode(nodeId: string): string {
  return nodeConnections.get(nodeId) ?? LOCAL_BACKEND_CONNECTION_ID;
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
