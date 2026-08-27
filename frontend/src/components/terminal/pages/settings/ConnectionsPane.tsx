import {
  cloneElement,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
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
import { BorderBtn } from '../../primitives';
import { confirmDialog } from '../../../ui/ConfirmDialog';

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
      setMessage({ kind: 'ok', text: 'Connection saved. Reload to import its existing workspaces.' });
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
    <div style={{ fontFamily: 'var(--ui-font)', color: 'var(--term-fg)' }}>
      <h1 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Backend connections</h1>
      <p style={{ color: 'var(--term-muted)', fontSize: 11.5, lineHeight: 1.5, margin: '8px 0 16px' }}>
        Each workspace stays attached to one backend. Local and remote sessions can stream side by side in the same app.
      </p>

      <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface-glass)' }}>
        <ConnectionRow connection={getKnownBackendConnections()[0]} local />
        {connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            workspaceCount={usage.get(connection.id) ?? 0}
            onEdit={() => {
              setDraft({
                id: connection.id,
                name: connection.name,
                transport: connection.transport,
                apiUrl: connection.apiUrl ?? '',
                sshHost: connection.sshHost ?? '',
                sshUser: connection.sshUser ?? '',
                sshPort: connection.sshPort ? String(connection.sshPort) : '',
                remotePort: String(connection.remotePort ?? 3000),
                token: '',
              });
              setMessage(null);
            }}
            onRemove={() => { void remove(connection); }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <BorderBtn onClick={() => { setDraft({ ...EMPTY_DRAFT }); setMessage(null); }}>+ add remote backend</BorderBtn>
        {connections.length > 0 && (
          <BorderBtn onClick={() => window.location.reload()}>reload workspaces</BorderBtn>
        )}
      </div>

      {draft && (
        <div style={{ border: '1px solid var(--term-line)', marginTop: 14, padding: 12, background: 'var(--term-surface)' }}>
          <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 10 }}>
            {draft.id ? 'Edit remote backend' : 'New remote backend'}
          </div>
          <Field label="name">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="build-server" />
          </Field>
          <Field label="transport">
            <select
              aria-label="Connection transport"
              value={draft.transport}
              onChange={(e) => setDraft({ ...draft, transport: e.target.value as 'direct' | 'ssh' })}
            >
              <option value="ssh">SSH tunnel</option>
              <option value="direct">Direct URL</option>
            </select>
          </Field>
          {draft.transport === 'direct' ? (
            <Field label="URL">
              <input value={draft.apiUrl} onChange={(e) => setDraft({ ...draft, apiUrl: e.target.value })} placeholder="https://michi.example.com:3000" />
            </Field>
          ) : (
            <>
              <Field label="SSH host">
                <input
                  aria-label="SSH host"
                  value={draft.sshHost}
                  onChange={(e) => setDraft({ ...draft, sshHost: e.target.value })}
                  placeholder="build-server-host or ~/.ssh/config alias"
                />
              </Field>
              <Field label="SSH user">
                <input
                  aria-label="SSH user"
                  value={draft.sshUser}
                  onChange={(e) => setDraft({ ...draft, sshUser: e.target.value })}
                  placeholder="optional"
                />
              </Field>
              <Field label="SSH port">
                <input
                  aria-label="SSH port"
                  inputMode="numeric"
                  value={draft.sshPort}
                  onChange={(e) => setDraft({ ...draft, sshPort: e.target.value })}
                  placeholder="22 (optional)"
                />
              </Field>
              <Field label="remote port">
                <input
                  aria-label="Remote Michi port"
                  inputMode="numeric"
                  value={draft.remotePort}
                  onChange={(e) => setDraft({ ...draft, remotePort: e.target.value })}
                  placeholder="3000"
                />
              </Field>
              <div style={{ color: 'var(--term-muted)', fontSize: 10.5, lineHeight: 1.45, margin: '2px 0 10px' }}>
                Michi runs <code>ssh -L</code> through your existing ~/.ssh/config and ssh-agent. Complete the first login and host-key confirmation in Terminal before testing here.
              </div>
            </>
          )}
          <Field label="token">
            <input
              type="password"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
              placeholder={draft.id ? 'leave blank to keep saved token' : 'MICHI_REMOTE_TOKEN'}
            />
          </Field>
          <div style={{ color: 'var(--term-muted)', fontSize: 10.5, lineHeight: 1.45, margin: '2px 0 10px' }}>
            The token is stored only by the local Backend in ~/.michi/config.json (mode 0600) and is never exposed to the renderer.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <BorderBtn disabled={busy} onClick={() => { void runTest(); }}>{busy ? 'testing…' : 'test connection'}</BorderBtn>
            <BorderBtn disabled={busy} onClick={() => { void save(); }}>save</BorderBtn>
            <BorderBtn disabled={busy} onClick={() => setDraft(null)}>cancel</BorderBtn>
          </div>
        </div>
      )}

      {message && (
        <div role="status" style={{ marginTop: 10, color: message.kind === 'ok' ? 'var(--term-accent)' : 'var(--term-danger)', fontSize: 11.5 }}>
          {message.text}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--term-line)', marginTop: 20, paddingTop: 12, color: 'var(--term-muted)', fontSize: 10.5, lineHeight: 1.55 }}>
        SSH launch: <code>MICHI_REMOTE_ACCESS=1 MICHI_BIND_HOST=127.0.0.1 MICHI_REMOTE_TOKEN=… PORT=3000 npm run remote:start</code>. Run it under systemd, pm2, Docker, or another service manager so it survives SSH and local App exits.
      </div>
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
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderBottom: '1px solid var(--term-line)' }}>
      <span style={{ color: local ? 'var(--term-accent)' : 'var(--term-mid)', fontSize: 12 }}>{local ? '●' : '◇'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{connection.name}</div>
        <div style={{ color: 'var(--term-muted)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {local
            ? 'Bundled backend · stopped when the App quits'
            : connection.transport === 'ssh'
              ? `SSH · ${connection.sshUser ? `${connection.sshUser}@` : ''}${connection.sshHost}:${connection.sshPort ?? 22} → 127.0.0.1:${connection.remotePort ?? 3000}`
              : connection.apiUrl}
        </div>
        {!local && connection.transport === 'ssh' && (
          <div style={{ color: connection.tunnelStatus === 'error' ? 'var(--term-danger)' : 'var(--term-faint)', fontSize: 10 }}>
            tunnel {connection.tunnelStatus === 'disconnected' ? 'on demand' : connection.tunnelStatus ?? 'on demand'}
            {connection.tunnelError ? ` · ${connection.tunnelError}` : ''}
          </div>
        )}
      </div>
      {!local && <span style={{ color: 'var(--term-faint)', fontSize: 10 }}>{workspaceCount} ws</span>}
      {onEdit && <BorderBtn onClick={onEdit}>edit</BorderBtn>}
      {onRemove && <BorderBtn onClick={onRemove}>remove</BorderBtn>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactElement<{ style?: CSSProperties }> }) {
  const input = cloneElement(children, {
    style: {
      width: '100%',
      boxSizing: 'border-box',
      border: '1px solid var(--term-line)',
      background: 'var(--term-alt)',
      color: 'var(--term-fg)',
      padding: '6px 8px',
      fontFamily: 'var(--mono-font, ui-monospace, monospace)',
      fontSize: 11.5,
      outline: 'none',
    },
  });
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '58px minmax(0, 1fr)', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11, color: 'var(--term-muted)' }}>
      <span>{label}</span>
      {input}
    </label>
  );
}
