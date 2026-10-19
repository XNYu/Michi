import { Monitor, Server } from 'lucide-react';
import { LOCAL_BACKEND_CONNECTION_ID, type BackendConnectionSummary } from '../config/backendConnections';
import { useBackendConnections } from '../state/useBackendConnections';
import './WorkspaceLocation.css';

export function workspaceMachineLabel(connectionId: string | undefined, connections: BackendConnectionSummary[], separator = ' · '): string {
  if (!connectionId || connectionId === LOCAL_BACKEND_CONNECTION_ID) return 'Local';
  const connection = connections.find(item => item.id === connectionId);
  return `Remote${separator}${connection?.name || connection?.sshHost || 'Unavailable connection'}`;
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
