import {
  cloneElement,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import {
  deleteBackendConnection,
  listBackendConnections,
  saveBackendConnection,
  testBackendConnection,
} from '../../../../services/api';
import {
  getKnownBackendConnections,
  setKnownBackendConnections,
  type BackendConnectionSummary,
} from '../../../../config/backendConnections';
import type { Project } from '../../../../state/chatTypes';
import { Button } from '../../../ui/controls';
import '../../../RemoteConnection.css';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { RemoteDesktopConnect } from '../../../RemoteDesktopConnect';

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

export function ConnectionsPane({ projects }: { projects: Project[] }) {
  const [connections, setConnections] = useState<BackendConnectionSummary[]>([]);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [quickConnect, setQuickConnect] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const refresh = async () => {
    const remote = await listBackendConnections();
    setKnownBackendConnections(remote);
    setConnections(remote);
  };

  useEffect(() => {
    void refresh().catch((err) => setMessage({ kind: 'error', text: (err as Error).message }));
  }, []);

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      if (!project.backendConnectionId) continue;
      counts.set(project.backendConnectionId, (counts.get(project.backendConnectionId) ?? 0) + 1);
    }
    return counts;
  }, [projects]);

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

  const remove = async (connection: BackendConnectionSummary) => {
    const inUse = usage.get(connection.id) ?? 0;
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
        <ConnectionRow connection={getKnownBackendConnections()[0]} local />
        {connections.map(connection => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            workspaceCount={usage.get(connection.id) ?? 0}
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
            onRemove={() => { void remove(connection); }}
          />
        ))}
      </ul>

      {!quickConnect && !draft && <>
        <div className="remote-connections__actions">
          <Button variant="primary" onClick={() => { setQuickConnect(true); setMessage(null); }}>
            Connect remote
          </Button>
          <Button variant="ghost" onClick={() => { setDraft({ ...EMPTY_DRAFT }); setMessage(null); }}>
            Manual setup…
          </Button>
        </div>
        <p className="remote-connections__hint">Connect a Linux machine over SSH.</p>
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

function ConnectionRow({
  connection,
  local = false,
  workspaceCount = 0,
  onEdit,
  onRemove,
}: {
  connection: BackendConnectionSummary;
  local?: boolean;
  workspaceCount?: number;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const address = local ? 'Workspaces on this computer'
    : connection.transport === 'ssh'
      ? `SSH · ${connection.sshUser ? `${connection.sshUser}@` : ''}${connection.sshHost}${connection.sshPort ? `:${connection.sshPort}` : ''}`
      : connection.apiUrl;
  const tunnelState = connection.tunnelStatus ?? 'disconnected';
  const status = local ? 'Built in'
    : connection.transport === 'direct' ? 'Direct URL'
      : { connected: 'SSH connected', connecting: 'Connecting…', error: 'Connection issue', disconnected: 'Connects when needed' }[tunnelState];
  return (
    <li className="remote-machine">
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
          <span className="remote-machine__count">{workspaceCount} {workspaceCount === 1 ? 'workspace' : 'workspaces'}</span>
          <div className="remote-machine__actions">
            {onEdit && <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>}
            {onRemove && <Button variant="ghost" size="sm" danger onClick={onRemove}>Remove</Button>}
          </div>
        </div>}
        {!local && connection.tunnelError && <p role="status" className="remote-connection-notice" data-tone="error">
          {connection.tunnelError}
        </p>}
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
