import { Monitor, Server } from 'lucide-react';
import { LOCAL_BACKEND_CONNECTION_ID, type BackendConnectionSummary } from '../config/backendConnections';
import { useBackendConnections } from '../state/useBackendConnections';
import './WorkspaceLocation.css';

/** The remote machine a workspace lives on, by its connection's name; null for a local workspace. */
export function remoteMachineName(connectionId: string | undefined, connections: BackendConnectionSummary[]): string | null {
  if (!connectionId || connectionId === LOCAL_BACKEND_CONNECTION_ID) return null;
  const connection = connections.find(item => item.id === connectionId);
  return connection?.name || connection?.sshHost || 'Unavailable connection';
}

export function workspaceMachineLabel(connectionId: string | undefined, connections: BackendConnectionSummary[], separator = ' · '): string {
  const remote = remoteMachineName(connectionId, connections);
  return remote === null ? 'Local' : `Remote${separator}${remote}`;
}

/** The note a workspace picker shows after a remote workspace's name; none for a local one. */
export function workspaceRemoteNote(connectionId: string | undefined, connections: BackendConnectionSummary[]): string | undefined {
  if (!connectionId || connectionId === LOCAL_BACKEND_CONNECTION_ID) return undefined;
  return workspaceMachineLabel(connectionId, connections);
}

export function WorkspaceLocation({ connectionId, separator }: { connectionId?: string; separator?: string }) {
  const connections = useBackendConnections();
  const remote = !!connectionId && connectionId !== LOCAL_BACKEND_CONNECTION_ID;
  const connection = connections.find(item => item.id === connectionId);
  const label = workspaceMachineLabel(connectionId, connections, separator);
  const address = connection?.transport === 'ssh' ? connection.sshHost : connection?.apiUrl;
  const Icon = remote ? Server : Monitor;
  return <span className="workspace-location" data-remote={remote || undefined} title={remote ? `${label} · ${address || connectionId}` : 'Workspace on this computer'}>
    <Icon size={12} aria-hidden="true" />
    <span>{label}</span>
  </span>;
}
