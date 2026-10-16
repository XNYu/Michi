import { useEffect, useId, useRef, useState } from 'react';
import { connectRemoteDesktop } from '../services/api/backendConnections';
import type { BackendConnectionSummary } from '../config/backendConnections';
import { Button } from './ui/controls';
import './RemoteConnection.css';

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
  const hostHintId = useId();
  const errorId = useId();
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

  return <div className="remote-connect" aria-busy={busy}>
    <label className="remote-connect__label" htmlFor={hostInputId}>Remote SSH host</label>
    <div className="remote-connect__entry">
      <input className="ui-input" id={hostInputId} placeholder="SSH alias or user@hostname" value={host} disabled={busy}
        spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-describedby={`${hostHintId}${error ? ` ${errorId}` : ''}`}
        aria-invalid={error ? true : undefined}
        onChange={event => { setHost(event.target.value); setInstallHost(null); setMessage(''); setError(''); setWarnings([]); setRuntimes(null); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void connect(false); } }} />
      <Button variant="primary" disabled={busy || !host.trim()} onClick={() => { void connect(false); }}>{busy ? 'Connecting…' : 'Connect'}</Button>
    </div>
    <p id={hostHintId} className="remote-connect__hint">Use the same host you connect to in Terminal.</p>
    {message && <p className="remote-connection-notice" role="status" aria-live="polite"
      data-tone={runtimes ? 'success' : undefined}>{message}</p>}
    {installHost === host && <div className="remote-connect__install">
      <p>Michi will prepare Node.js if needed, fetch its source and build here. It runs in the background. First setup may take a few minutes.</p>
      <Button variant="primary" disabled={busy} onClick={() => { void connect(true); }}>Install and connect</Button>
    </div>}
    {error && <p id={errorId} role="alert" className="remote-connection-notice" data-tone="error">{error}</p>}
    {runtimes?.length === 0 && <p className="remote-connection-notice" role="status">Set up an agent on the remote machine before starting a chat.</p>}
    {warnings.map(warning => <p key={warning} role="status" className="remote-connection-notice">{warning}</p>)}
    <details className="remote-connect__help">
      <summary>First time connecting?</summary>
      <p>Run <code>ssh {host.trim().replace(/^ssh\s+/, '') || 'your-host'}</code> in Terminal to complete SSH sign-in and confirm the host. Sign in to your agent on that machine too.</p>
    </details>
  </div>;
}
