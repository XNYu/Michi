import {
  cloneElement,
  useEffect,
  useState,
  type ReactElement,
} from 'react';
import {
  deleteBackendConnection,
  listBackendConnectionState,
  saveBackendConnection,
  testBackendConnection,
} from '../../../../services/api';
import {
  LOCAL_BACKEND_CONNECTION,
  setKnownBackendConnections,
  type BackendConnectionSummary,
} from '../../../../config/backendConnections';
import type { Project } from '../../../../state/chatTypes';
import { Button } from '../../../ui/controls';
import '../../../RemoteConnection.css';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { RemoteDesktopConnect } from '../../../RemoteDesktopConnect';
import { useRemoteWorkspaces, type RemoteWorkspacesState } from './useRemoteWorkspaces';

type ConnectionDraft = {
  id?: string;
  name: string;
  transport: 'direct' | 'ssh';
  apiUrl: string;
  sshHost: string;
  sshUser: string;
  sshPort: string;
  remotePort: string;
  token: string;
};

const EMPTY_DRAFT: ConnectionDraft = {
  name: '',
  transport: 'ssh',
  apiUrl: '',
  sshHost: '',
  sshUser: '',
  sshPort: '',
  remotePort: '3000',
  token: '',
};

function draftInput(draft: ConnectionDraft) {
  const common = {
    id: draft.id,
    name: draft.name,
    transport: draft.transport,
    token: draft.token,
  } as const;
  if (draft.transport === 'direct') {
    return { ...common, transport: 'direct' as const, apiUrl: draft.apiUrl };
  }
  return {
    ...common,
    transport: 'ssh' as const,
    sshHost: draft.sshHost,
    sshUser: draft.sshUser,
    sshPort: draft.sshPort.trim() ? Number(draft.sshPort) : null,
    remotePort: draft.remotePort.trim() ? Number(draft.remotePort) : null,
  };
}

export function ConnectionsPane({ projects, onOpenWorkspace }: { projects: Project[]; onOpenWorkspace?: (projectId: string) => void }) {
  const [connections, setConnections] = useState<BackendConnectionSummary[]>([]);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [quickConnect, setQuickConnect] = useState(false);
  const [connectByHost, setConnectByHost] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const refresh = async () => {
    const state = await listBackendConnectionState();
    setKnownBackendConnections(state.connections);
    setConnections(state.connections);
    setConnectByHost(state.connectByHost);
  };

  useEffect(() => {
    void refresh().catch((err) => setMessage({ kind: 'error', text: (err as Error).message }));
  }, []);

  const runTest = async () => {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await testBackendConnection(draftInput(draft));
      setMessage(result.ok
        ? { kind: 'ok', text: `Connected to Michi backend${result.serverId ? ` · ${result.serverId}` : ''}` }
        : { kind: 'error', text: result.error || 'Connection failed' });
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const input = draftInput(draft);
      const probe = await testBackendConnection(input);
      if (!probe.ok) {
        setMessage({ kind: 'error', text: probe.error || 'Connection failed' });
        return;
      }
      await saveBackendConnection(input);
      await refresh();
      setDraft(null);
      setMessage({ kind: 'ok', text: 'Connection saved. Its workspaces will appear automatically.' });
      window.dispatchEvent(new CustomEvent('michi:backend-connections-changed'));
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (connection: BackendConnectionSummary, inUse: number) => {
    // The fresh remote count includes Trash, which still needs its connection for restoration.
    if (inUse > 0) {
      setMessage({ kind: 'error', text: `${inUse} workspace${inUse === 1 ? '' : 's'} still use this connection.` });
      return;
    }
    if (!(await confirmDialog({
      title: 'Remove remote connection',
      message: `Remove “${connection.name}”? The remote server and its data will not be changed.`,
      confirmLabel: 'Remove',
    }))) return;
    try {
      await deleteBackendConnection(connection.id);
      await refresh();
      if (draft?.id === connection.id) setDraft(null);
      window.dispatchEvent(new CustomEvent('michi:backend-connections-changed'));
    } catch (err) {
      setMessage({ kind: 'error', text: (err as Error).message });
    }
  };

  return (
    <div className="remote-connections">
      <h1>Connected machines</h1>
      <p className="remote-connections__intro">
        Work locally or connect a remote machine. Choose a machine when creating a workspace.
      </p>

      <ul className="remote-connections__list" aria-label="Machines">
        <ConnectionRow connection={LOCAL_BACKEND_CONNECTION} local />
        {connections.map(connection => (
          <RemoteConnectionRow
            key={JSON.stringify([connection.id, connection.updatedAt, connection.transport, connection.apiUrl,
              connection.sshHost, connection.sshUser, connection.sshPort, connection.remotePort, connection.hasToken])}
            connection={connection}
            // Local hydration determines only whether navigation is safe, never remote membership.
            canOpenWorkspace={id => projects.some(project => project.id === id
              && project.backendConnectionId === connection.id && !project.deletedAt && !project.archivedAt)}
            onOpenWorkspace={onOpenWorkspace}
            onEdit={() => {
              setQuickConnect(false);
              setDraft({
                id: connection.id, name: connection.name, transport: connection.transport,
                apiUrl: connection.apiUrl ?? '', sshHost: connection.sshHost ?? '',
                sshUser: connection.sshUser ?? '',
                sshPort: connection.sshPort ? String(connection.sshPort) : '',
                remotePort: String(connection.remotePort ?? 3000), token: '',
              });
              setMessage(null);
            }}
            onRemove={count => remove(connection, count)}
          />
        ))}
      </ul>

      {!quickConnect && !draft && <>
        <div className="remote-connections__actions">
          {connectByHost && <Button variant="primary" onClick={() => { setQuickConnect(true); setMessage(null); }}>
            Connect remote
          </Button>}
          <Button variant={connectByHost ? 'ghost' : 'primary'} onClick={() => { setDraft({ ...EMPTY_DRAFT }); setMessage(null); }}>
            Manual setup…
          </Button>
        </div>
        {connectByHost && <p className="remote-connections__hint">Connect a Linux machine over SSH.</p>}
      </>}

      {quickConnect && <section className="remote-connection-panel" aria-label="Connect remote">
        <div className="remote-connection-panel__heading">
          <h2>Connect remote</h2>
          <Button variant="ghost" size="sm" onClick={() => setQuickConnect(false)}>Cancel</Button>
        </div>
        <RemoteDesktopConnect onConnected={() => {
          void refresh().catch(err => setMessage({ kind: 'error', text: (err as Error).message }));
          window.dispatchEvent(new CustomEvent('michi:backend-connections-changed'));
        }} />
      </section>}

      {draft && <section className="remote-connection-panel" aria-label={draft.id ? 'Edit connection' : 'Manual connection'}>
        <div className="remote-connection-panel__heading">
          <h2>{draft.id ? 'Edit connection' : 'Manual connection'}</h2>
        </div>
        <div className="remote-connection-form">
          {!draft.id && <p className="remote-connection-form__hint">
            For a machine already running Michi. Enter its connection details below.
          </p>}
          <Field label="Name">
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="build-server" />
          </Field>
          <Field label="Connection type">
            <select aria-label="Connection transport" value={draft.transport}
              onChange={e => setDraft({ ...draft, transport: e.target.value as 'direct' | 'ssh' })}>
              <option value="ssh">SSH tunnel</option>
              <option value="direct">Direct URL</option>
            </select>
          </Field>
          {draft.transport === 'direct' ? (
            <Field label="Server URL">
              <input value={draft.apiUrl} onChange={e => setDraft({ ...draft, apiUrl: e.target.value })} placeholder="https://michi.example.com:3000" />
            </Field>
          ) : <>
            <Field label="SSH host">
              <input aria-label="SSH host" value={draft.sshHost}
                onChange={e => setDraft({ ...draft, sshHost: e.target.value })} placeholder="SSH alias or hostname" />
            </Field>
            <Field label="SSH user">
              <input aria-label="SSH user" value={draft.sshUser}
                onChange={e => setDraft({ ...draft, sshUser: e.target.value })} placeholder="From SSH config" />
            </Field>
            <div className="remote-connection-form__pair">
              <Field label="SSH port">
                <input aria-label="SSH port" inputMode="numeric" value={draft.sshPort}
                  onChange={e => setDraft({ ...draft, sshPort: e.target.value })} placeholder="22 (optional)" />
              </Field>
              <Field label="Michi port">
                <input aria-label="Remote Michi port" inputMode="numeric" value={draft.remotePort}
                  onChange={e => setDraft({ ...draft, remotePort: e.target.value })} placeholder="3000" />
              </Field>
            </div>
            <p className="remote-connection-form__hint">
              Uses your SSH config. Complete your first SSH sign-in in Terminal before connecting here.
            </p>
          </>}
          <Field label="Access token">
            <input type="password" autoComplete="off" value={draft.token}
              onChange={e => setDraft({ ...draft, token: e.target.value })}
              placeholder={draft.id ? 'Leave blank to keep saved token' : 'MICHI_REMOTE_TOKEN'} />
          </Field>
          <p className="remote-connection-form__hint">
            {draft.id ? 'Leave blank to keep the saved token.' : 'Use the token from your remote Michi server.'} Saved securely on this computer.
          </p>
          <div className="remote-connection-form__actions">
            <Button disabled={busy} onClick={() => { void runTest(); }}>{busy ? 'Checking…' : 'Test connection'}</Button>
            <Button variant="primary" disabled={busy} onClick={() => { void save(); }}>Save</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      </section>}

      {message && <div role={message.kind === 'error' ? 'alert' : 'status'}
        className="remote-connection-notice" data-tone={message.kind === 'ok' ? 'success' : 'error'}>
        {message.text}
      </div>}
    </div>
  );
}

interface ConnectionRowProps {
  connection: BackendConnectionSummary;
  local?: boolean;
  workspaceState?: RemoteWorkspacesState;
  canOpenWorkspace?: (id: string) => boolean;
  onOpenWorkspace?: (projectId: string) => void;
  onRefresh?: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
}

function RemoteConnectionRow({ onRemove, ...props }: Omit<ConnectionRowProps, 'local' | 'workspaceState' | 'onRefresh' | 'onRemove'> & {
  onRemove: (workspaceCount: number) => Promise<void>;
}) {
  const { state, refresh } = useRemoteWorkspaces(props.connection.id);
  return <ConnectionRow {...props} workspaceState={state} onRefresh={() => { void refresh(); }} onRemove={() => {
    // Recheck on removal too: membership may have changed since the pane opened.
    void refresh().then(workspaces => { if (workspaces) return onRemove(workspaces.length); });
  }} />;
}

function ConnectionRow({
  connection,
  local = false,
  workspaceState,
  canOpenWorkspace,
  onOpenWorkspace,
  onRefresh,
  onEdit,
  onRemove,
}: ConnectionRowProps) {
  const workspaces = workspaceState?.status === 'ready' ? workspaceState.workspaces.filter(workspace => !workspace.deletedAt) : [];
  const loading = workspaceState?.status === 'loading';
  const address = local ? 'Workspaces on this computer'
    : connection.transport === 'ssh'
      ? `SSH · ${connection.sshUser ? `${connection.sshUser}@` : ''}${connection.sshHost}${connection.sshPort ? `:${connection.sshPort}` : ''}`
      : connection.apiUrl;
  const tunnelState = workspaceState?.status === 'ready' ? 'connected'
    : workspaceState?.status === 'loading' ? 'connecting'
      : workspaceState?.status === 'error' ? 'error' : connection.tunnelStatus ?? 'disconnected';
  const status = local ? 'Built in'
    : connection.transport === 'direct' ? 'Direct URL'
      : { connected: 'SSH connected', connecting: 'Connecting…', error: 'Connection issue', disconnected: 'Connects when needed' }[tunnelState];
  return (
    <li className="remote-machine" aria-label={connection.name}>
      <svg className="remote-machine__icon" width="18" height="18" viewBox="0 0 18 18" fill="none"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {local ? <><rect x="2" y="3" width="14" height="10" rx="1.5" /><path d="M6 16h6M9 13v3" /></>
          : <><rect x="3" y="2" width="12" height="14" rx="1.5" /><path d="M3 9h12M6 5.5h.01M6 12.5h.01M9 5.5h3M9 12.5h3" /></>}
      </svg>
      <div>
        <div className="remote-machine__heading">
          <span className="remote-machine__name">{connection.name}</span>
          <span className="remote-machine__status" data-state={!local && connection.transport === 'ssh' ? tunnelState : undefined}>
            {!local && connection.transport === 'ssh' && <span className="remote-machine__dot" aria-hidden="true" />}
            {status}
          </span>
        </div>
        <div className="remote-machine__address" title={address}>{address}</div>
        {!local && <div className="remote-machine__footer">
          <div className="remote-machine__actions">
            {onRefresh && <Button variant="ghost" size="sm" disabled={loading} onClick={onRefresh}>
              {workspaceState?.status === 'error' ? 'Retry workspaces' : 'Refresh workspaces'}
            </Button>}
            {onEdit && <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>}
            {onRemove && <Button variant="ghost" size="sm" danger disabled={loading} onClick={onRemove}>Remove</Button>}
          </div>
        </div>}
        {!local && <details className="remote-machine__workspaces" open aria-busy={loading}>
          <summary>{loading ? 'Reading remote workspaces…' : workspaceState?.status === 'error' ? 'Workspaces unavailable'
            : `${workspaces.length} ${workspaces.length === 1 ? 'workspace' : 'workspaces'}`}</summary>
          {loading && <p role="status">Connecting to this machine and reading its current workspaces…</p>}
          {workspaceState?.status === 'error' && <p role="alert" className="remote-connection-notice" data-tone="error">{workspaceState.message}</p>}
          {workspaceState?.status === 'ready' && (workspaces.length === 0 ? <p>No workspaces on this machine.</p> : <ul aria-label={`Workspaces on ${connection.name}`}>
            {workspaces.map(workspace => <li key={workspace.id} className="remote-machine__workspace">
              <div className="remote-machine__workspace-heading">
                {onOpenWorkspace && !workspace.archivedAt && canOpenWorkspace?.(workspace.id)
                  ? <Button variant="ghost" size="sm" className="remote-machine__workspace-link" onClick={() => onOpenWorkspace(workspace.id)}>{workspace.name}</Button>
                  : <span className="remote-machine__workspace-name">{workspace.name}</span>}
                {!!workspace.archivedAt && <span className="remote-machine__workspace-archived">Archived</span>}
              </div>
              <span className="remote-machine__workspace-path" title={workspace.cwd ?? undefined}>{workspace.cwd || 'No folder'}</span>
            </li>)}
          </ul>)}
        </details>}
      </div>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactElement<{ className?: string }> }) {
  return <label className="remote-connection-form__field">
    <span>{label}</span>
    {cloneElement(children, { className: children.type === 'select' ? 'ui-select' : 'ui-input' })}
  </label>;
}
