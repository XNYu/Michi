import { useEffect, useId, useRef, useState } from 'react';
import { connectRemoteDesktop } from '../services/api/backendConnections';
import type { BackendConnectionSummary } from '../config/backendConnections';
import { Button } from './ui/controls';

export function RemoteDesktopConnect({ onConnected }: {
  onConnected: (connection: BackendConnectionSummary, home: string, warnings: string[]) => void;
}) {
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [installHost, setInstallHost] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [runtimes, setRuntimes] = useState<string[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const request = useRef<AbortController | null>(null);
  const hostInputId = useId();
  useEffect(() => () => { request.current?.abort(); }, []);

  const connect = async (install: boolean) => {
    if (!host.trim() || busy) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setWarnings([]); setRuntimes(null); setMessage('Connecting to the remote machine…');
    try {
      const result = await connectRemoteDesktop(host, install, setMessage, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === 'install_required') {
        setInstallHost(host); setMessage('Michi needs to be prepared on this machine.');
      } else {
        setInstallHost(null); setMessage(`Connected to ${result.connection.name}`);
        setRuntimes(result.runtimes);
        setWarnings(result.runtimeWarnings ?? []);
        onConnected(result.connection, result.home, result.runtimeWarnings ?? []);
      }
    } catch (failure) {
      if (!controller.signal.aborted) { setError((failure as Error).message); setMessage(''); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };

  return <div style={{ padding: 14, border: '1px solid var(--term-line)', background: 'var(--term-surface)', fontSize: 'var(--fs-md)' }}>
    <label style={{ display: 'block', marginBottom: 8 }} htmlFor={hostInputId}>Remote SSH host</label>
    <div style={{ display: 'flex', gap: 8 }}>
      <input id={hostInputId} placeholder="SSH alias or user@hostname" value={host} disabled={busy}
        onChange={event => { setHost(event.target.value); setInstallHost(null); setMessage(''); setError(''); setWarnings([]); setRuntimes(null); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void connect(false); } }}
        style={{ minWidth: 0, flex: 1, padding: '8px 10px', border: '1px solid var(--term-line)', background: 'var(--term-alt)', color: 'var(--term-fg)' }} />
      <Button disabled={busy || !host.trim()} onClick={() => { void connect(false); }}>Connect</Button>
    </div>
    {message && <p role="status" aria-live="polite">{message}</p>}
    {installHost === host && <div>
      <p style={{ color: 'var(--term-muted)', lineHeight: 1.5 }}>
        Michi will fetch its source, build on this machine and start in the background. Node.js will be installed in your user directory if needed. The first build may take a few minutes.
      </p>
      <Button variant="primary" disabled={busy} onClick={() => { void connect(true); }}>Install and connect</Button>
    </div>}
    {error && <p role="alert" style={{ color: 'var(--term-danger)' }}>{error}</p>}
    {runtimes?.length === 0 && <p style={{ color: 'var(--term-muted)' }}>Connected. Set up an agent runtime on this machine before starting a chat.</p>}
    {warnings.map(warning => <p key={warning} role="status" style={{ color: 'var(--term-muted)', lineHeight: 1.5 }}>{warning}</p>)}
  </div>;
}
