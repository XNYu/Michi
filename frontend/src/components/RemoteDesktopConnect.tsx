import { useEffect, useId, useRef, useState } from 'react';
import { formatRemoteDiagnostic, type RemoteConnectionDiagnostic } from 'michi-shared';
import { fetchAgentStatus } from '../services/api/agentRuntime';
import { askLocalDiagnosticAgent, localDiagnosticRuntime } from '../services/remoteDiagnosticAgent';
import { connectRemoteDesktop } from '../services/api/backendConnections';
import type { BackendConnectionSummary } from '../config/backendConnections';
import { RemoteRuntimeSummary } from './RemoteRuntimeSummary';
import { Button } from './ui/controls';
import './RemoteConnection.css';

const STAGE_LABELS: Record<string, string> = { request: 'starting the request', ssh: 'SSH connection', node: 'Node.js setup', source: 'fetching source', build: 'remote build', start: 'service startup', tunnel: 'SSH forwarding', verify: 'connection verification', runtime: 'runtime detection' };

export function RemoteDesktopConnect({ onConnected }: {
  onConnected: (connection: BackendConnectionSummary, home: string, warnings: string[], runtimes: string[]) => void;
}) {
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [installHost, setInstallHost] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState<RemoteConnectionDiagnostic | null>(null);
  const [localAgent, setLocalAgent] = useState<ReturnType<typeof localDiagnosticRuntime>>(null);
  const [agentStatus, setAgentStatus] = useState('');
  const [diagnosticFeedback, setDiagnosticFeedback] = useState('');
  const [sendingDiagnostic, setSendingDiagnostic] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [stage, setStage] = useState('');
  const [runtimes, setRuntimes] = useState<string[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const request = useRef<AbortController | null>(null);
  const hostInputId = useId();
  const hostHintId = useId();
  const errorId = useId();
  useEffect(() => {
    if (!diagnostic) return;
    const controller = new AbortController();
    setLocalAgent(null); setAgentStatus('Checking local agents…');
    void fetchAgentStatus('local', controller.signal).then(status => {
      if (controller.signal.aborted) return;
      const agent = localDiagnosticRuntime(status); setLocalAgent(agent);
      setAgentStatus(agent ? 'Opens a new local chat with ' + agent.label + ' and sends these diagnostics.' : 'No ready local runtime. View or copy diagnostics below.');
    }).catch(() => { if (!controller.signal.aborted) setAgentStatus('Local runtime status is unavailable. You can still view and copy diagnostics.'); });
    return () => controller.abort();
  }, [diagnostic]);
  useEffect(() => () => { request.current?.abort(); }, []);

  const connect = async (install: boolean) => {
    if (!host.trim() || busy || sendingDiagnostic) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setDiagnostic(null); setDiagnosticFeedback(''); setShowLogs(false); setStage('ssh'); setWarnings([]); setRuntimes(null); setMessage('Connecting to the remote machine…');
    try {
      const result = await connectRemoteDesktop(host, install, setMessage, controller.signal, setStage);
      if (controller.signal.aborted) return;
      if (result.kind === 'install_required') {
        setInstallHost(host); setMessage('Michi needs to be prepared on this machine.');
      } else {
        setInstallHost(null); setMessage(`Connected to ${result.connection.name}`);
        setRuntimes(result.runtimes);
        setWarnings(result.runtimeWarnings ?? []);
        onConnected(result.connection, result.home, result.runtimeWarnings ?? [], result.runtimes);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message); setMessage('');
        const report = (failure as { diagnostic?: RemoteConnectionDiagnostic })?.diagnostic;
        setDiagnostic(report ?? { id: 'client-' + crypto.randomUUID(), host, startedAt: new Date().toISOString(), stage: stage || 'request', code: 'connection_failed', message, log: message, truncated: false });
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  };

  const copyDiagnostics = async () => {
    if (!diagnostic) return;
    try { await navigator.clipboard.writeText(formatRemoteDiagnostic(diagnostic)); setDiagnosticFeedback('Diagnostics copied.'); }
    catch { setShowLogs(true); setDiagnosticFeedback('Clipboard unavailable. Select the log text below and copy it.'); }
  };
  const askAgent = async () => {
    if (!diagnostic || sendingDiagnostic) return;
    const controller = new AbortController(); request.current = controller;
    setSendingDiagnostic(true); setDiagnosticFeedback('');
    try {
      const agent = localDiagnosticRuntime(await fetchAgentStatus('local', AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])));
      if (controller.signal.aborted) return;
      if (!agent) { setLocalAgent(null); throw new Error('No ready local runtime. Copy diagnostics instead.'); }
      await askLocalDiagnosticAgent(diagnostic, agent.binding, controller.signal);
    } catch (error) { if (!controller.signal.aborted) setDiagnosticFeedback(error instanceof Error ? error.message : String(error)); }
    finally { if (!controller.signal.aborted) setSendingDiagnostic(false); }
  };

  return <div className="remote-connect" aria-busy={busy}>
    <label className="remote-connect__label" htmlFor={hostInputId}>Remote SSH host</label>
    <div className="remote-connect__entry">
      <input className="ui-input" id={hostInputId} placeholder="SSH alias or user@hostname" value={host} disabled={busy || sendingDiagnostic}
        spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-describedby={`${hostHintId}${error ? ` ${errorId}` : ''}`}
        aria-invalid={error ? true : undefined}
        onChange={event => { setHost(event.target.value); setDiagnostic(null); setDiagnosticFeedback(''); setInstallHost(null); setMessage(''); setError(''); setWarnings([]); setRuntimes(null); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void connect(false); } }} />
      <Button variant="primary" disabled={busy || sendingDiagnostic || !host.trim()} onClick={() => { void connect(false); }}>{busy ? 'Connecting…' : 'Connect'}</Button>
    </div>
    <p id={hostHintId} className="remote-connect__hint">Use the same host you connect to in Terminal.</p>
    {message && <p className="remote-connection-notice" role="status" aria-live="polite"
      data-tone={runtimes ? 'success' : undefined}>{message}</p>}
    {installHost === host && <div className="remote-connect__install">
      <p>Michi will prepare Node.js if needed, fetch its source and build here. It runs in the background. First setup may take a few minutes.</p>
      <Button variant="primary" disabled={busy} onClick={() => { void connect(true); }}>Install and connect</Button>
    </div>}
    {error && <p id={errorId} role="alert" className="remote-connection-notice" data-tone="error">{error}</p>}
    {diagnostic && <section className="remote-diagnostic" aria-label="Connection diagnostics">
      <p className="remote-connect__hint">Failed at <strong>{STAGE_LABELS[diagnostic.stage] ?? diagnostic.stage}</strong> · {diagnostic.code ?? 'connection_failed'}</p>
      <div className="remote-diagnostic__actions">
        <Button variant="secondary" onClick={() => setShowLogs(value => !value)} aria-expanded={showLogs}>{showLogs ? 'Hide logs' : 'View logs'}</Button>
        <Button variant="secondary" onClick={() => { void copyDiagnostics(); }}>Copy diagnostics</Button>
        {localAgent && <Button variant="primary" disabled={sendingDiagnostic} onClick={() => { void askAgent(); }}>{sendingDiagnostic ? 'Opening chat…' : 'Ask local agent'}</Button>}
      </div>
      <p className="remote-connect__hint" role="status">{agentStatus}</p>
      {showLogs && <>
        <p className="remote-connect__hint">Credentials are redacted. {diagnostic.truncated ? 'Capture limit reached; see the report for remote log paths.' : 'Captured output for this attempt.'}</p>
        <textarea className="remote-diagnostic__log ui-input" aria-label="Connection log" readOnly value={formatRemoteDiagnostic(diagnostic)} spellCheck={false} />
      </>}
      {diagnosticFeedback && <p role="status" className="remote-connection-notice">{diagnosticFeedback}</p>}
    </section>}
    {runtimes && <RemoteRuntimeSummary runtimes={runtimes} />}
    {warnings.map(warning => <p key={warning} role="status" className="remote-connection-notice">{warning}</p>)}
    <details className="remote-connect__help">
      <summary>First time connecting?</summary>
      <p>Run <code>ssh {host.trim().replace(/^ssh\s+/, '') || 'your-host'}</code> in Terminal to complete SSH sign-in and confirm the host. Sign in to your agent on that machine too.</p>
    </details>
  </div>;
}
