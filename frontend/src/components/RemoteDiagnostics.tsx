import { useEffect, useRef, useState } from 'react';
import { formatRemoteDiagnostic, type RemoteConnectionDiagnostic } from 'michi-shared';
import { fetchAgentStatus } from '../services/api/agentRuntime';
import { askLocalDiagnosticAgent, localDiagnosticRuntime } from '../services/remoteDiagnosticAgent';
import { Button } from './ui/controls';
import './RemoteConnection.css';

const STAGE_LABELS: Record<string, string> = { request: 'starting the request', ssh: 'SSH connection', node: 'Node.js setup', source: 'fetching source', build: 'remote build', start: 'service startup', tunnel: 'SSH forwarding', verify: 'connection verification', runtime: 'runtime detection', workspace: 'restoring remote workspaces' };

export function RemoteDiagnostics({ report, onBusyChange }: {
  report: RemoteConnectionDiagnostic; onBusyChange?: (busy: boolean) => void;
}) {
  const [localAgent, setLocalAgent] = useState<ReturnType<typeof localDiagnosticRuntime>>(null);
  const [agentStatus, setAgentStatus] = useState('Checking local agents…');
  const [feedback, setFeedback] = useState('');
  const [sending, setSending] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchAgentStatus('local', AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])).then(status => {
      if (controller.signal.aborted) return;
      const agent = localDiagnosticRuntime(status); setLocalAgent(agent);
      setAgentStatus(agent ? 'Opens a new local chat with ' + agent.label + ' and sends these diagnostics.' : 'No ready local runtime. View or copy diagnostics below.');
    }).catch(() => { if (!controller.signal.aborted) setAgentStatus('Local runtime status is unavailable. You can still view and copy diagnostics.'); });
    return () => { controller.abort(); request.current?.abort(); };
  }, []);

  const copy = async () => {
    try { await navigator.clipboard.writeText(formatRemoteDiagnostic(report)); setFeedback('Diagnostics copied.'); }
    catch { setShowLogs(true); setFeedback('Clipboard unavailable. Select the log text below and copy it.'); }
  };
  const askAgent = async () => {
    if (sending) return;
    const controller = new AbortController(); request.current = controller;
    setSending(true); onBusyChange?.(true); setFeedback('');
    try {
      const agent = localDiagnosticRuntime(await fetchAgentStatus('local', AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])));
      if (controller.signal.aborted) return;
      if (!agent) { setLocalAgent(null); throw new Error('No ready local runtime. Copy diagnostics instead.'); }
      await askLocalDiagnosticAgent(report, agent.binding, controller.signal);
    } catch (error) { if (!controller.signal.aborted) setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { if (!controller.signal.aborted) { setSending(false); onBusyChange?.(false); } }
  };

  return <section className="remote-diagnostic" aria-label="Connection diagnostics">
    <p className="remote-connect__hint">{report.severity === 'warning' ? 'Needs attention at' : 'Failed at'} <strong>{STAGE_LABELS[report.stage] ?? report.stage}</strong> · {report.code ?? 'connection_failed'}</p>
    <div className="remote-diagnostic__actions">
      <Button variant="secondary" onClick={() => setShowLogs(value => !value)} aria-expanded={showLogs}>{showLogs ? 'Hide logs' : 'View logs'}</Button>
      <Button variant="secondary" onClick={() => { void copy(); }}>Copy diagnostics</Button>
      {localAgent && <Button variant="primary" disabled={sending} onClick={() => { void askAgent(); }}>{sending ? 'Opening chat…' : 'Ask local agent'}</Button>}
    </div>
    <p className="remote-connect__hint" role="status">{agentStatus}</p>
    {showLogs && <>
      <p className="remote-connect__hint">Credentials are redacted. {report.stage === 'workspace' ? 'Recent client-side recovery attempts; remote service logs are not included.' : report.truncated ? 'Capture limit reached; see the report for available log paths.' : 'Captured output for this attempt.'}</p>
      <textarea className="remote-diagnostic__log ui-input" aria-label="Connection log" readOnly value={formatRemoteDiagnostic(report)} spellCheck={false} />
    </>}
    {feedback && <p role="status" className="remote-connection-notice">{feedback}</p>}
  </section>;
}
