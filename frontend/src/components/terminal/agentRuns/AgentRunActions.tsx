import React, { useRef, useState } from 'react';
import type { AgentRunEventV1 } from 'michi-shared';
import type { LocatedAgentRun } from './agentRunSelectors';
import { runIdentity } from './agentRunSelectors';
import { AgentRunActionApiError, continueAgentRunAsBranch, createAgentRunActionOperationId,
  saveAgentRunAsCustomAgent } from '../../../services/api/agentRunActions';

export function AgentRunActions({ run: resource, events = [] }: {
  run: LocatedAgentRun;
  events?: readonly AgentRunEventV1[];
}) {
  const run = resource.value;
  const identity = runIdentity(resource);
  const [includeTask, setIncludeTask] = useState(true);
  const [includeResult, setIncludeResult] = useState(!!run.resultBundle);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [busy, setBusy] = useState<'continue' | 'save' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [offerFallback, setOfferFallback] = useState(false);
  const continueOperationId = useRef(createAgentRunActionOperationId());
  const saveOperationId = useRef(createAgentRunActionOperationId());

  const continueRun = async (fallback: 'error' | 'new_thread') => {
    setBusy('continue'); setMessage(null);
    try {
      const result = await continueAgentRunAsBranch(identity, {
        version: 1, workspaceId: run.workspaceId, includeTask, includeResult, includeTranscript, fallback,
      }, continueOperationId.current);
      setOfferFallback(false);
      setMessage(result.mode === 'branch' ? `Branch created: ${result.nodeId}` : `New thread created: ${result.nodeId}`);
    } catch (error) {
      if (error instanceof AgentRunActionApiError && error.code === 'parent_unavailable') setOfferFallback(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(null); }
  };

  const save = async () => {
    setBusy('save'); setMessage(null);
    try {
      const saved = await saveAgentRunAsCustomAgent(identity, { version: 1, workspaceId: run.workspaceId }, saveOperationId.current);
      setMessage(`Draft saved: ${saved.value.name}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  return (
    <div data-testid="agent-run-actions" style={{ borderTop: '1px solid var(--term-line)', paddingTop: 9, display: 'grid', gap: 8 }}>
      <div style={{ color: 'var(--term-muted)', fontSize: 10 }}>Import selected Run material into a separate conversation history.</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 10 }}>
        <label><input type="checkbox" checked={includeTask} onChange={(e) => setIncludeTask(e.target.checked)} /> task</label>
        <label><input type="checkbox" checked={includeResult} disabled={!run.resultBundle} onChange={(e) => setIncludeResult(e.target.checked)} /> result</label>
        <label><input type="checkbox" checked={includeTranscript} disabled={events.length === 0} onChange={(e) => setIncludeTranscript(e.target.checked)} /> transcript</label>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy !== null || (!includeTask && !includeResult && !includeTranscript)} onClick={() => void continueRun('error')}
          style={{ border: '1px solid var(--term-accent)', background: 'transparent', color: 'var(--term-accent)', padding: '5px 8px', fontSize: 10, cursor: 'pointer' }}>
          {busy === 'continue' ? 'Creating…' : 'Continue as Branch'}
        </button>
        {offerFallback && <button type="button" disabled={busy !== null} onClick={() => void continueRun('new_thread')}
          style={{ border: '1px solid var(--term-select)', background: 'transparent', color: 'var(--term-select)', padding: '5px 8px', fontSize: 10, cursor: 'pointer' }}>Continue as new thread</button>}
        {run.definitionId === null && <button type="button" disabled={busy !== null} onClick={() => void save()}
          style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)', color: 'var(--term-fg)', padding: '5px 8px', fontSize: 10, cursor: 'pointer' }}>
          {busy === 'save' ? 'Saving…' : 'Save as Custom Agent'}
        </button>}
      </div>
      {message && <div role="status" style={{ color: offerFallback ? 'var(--term-select)' : 'var(--term-muted)', fontSize: 10 }}>{message}</div>}
    </div>
  );
}
