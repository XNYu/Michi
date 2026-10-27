import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentRunPaneItem } from '../../../state/paneItems';
import { agentResourceKey } from '../../../state/agentIdentity';
import { useChatActions } from '../../../state/chatStore';
import { useAgentDomain } from '../../../state/agentDomain';
import { getAgentRunDetail, respondAgentRunInteraction } from '../../../services/api';
import { AgentRunPane } from './AgentRunPane';

type Detail = Awaited<ReturnType<typeof getAgentRunDetail>>;
type LoadState = { identity: object; status: 'loading' | 'error' | 'ready'; error: string | null; attempts: Detail['value']['attempts'] };
const statusButtonStyle: React.CSSProperties = {
  marginTop: 10, marginRight: 8, padding: '4px 8px', border: '1px solid var(--term-line)',
  background: 'var(--term-surface)', color: 'var(--term-fg)', font: 'inherit', cursor: 'pointer',
};

export default function AgentRunPaneSurface({ item }: { item: AgentRunPaneItem }) {
  const { closePane } = useChatActions();
  const { state, dispatch, sendInput, cancel } = useAgentDomain();
  const identity = useMemo(() => ({ backendConnectionId: item.backendConnectionId, id: item.runId }), [item.backendConnectionId, item.runId]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const actionInFlight = useRef<object | null>(null);
  const [load, setLoad] = useState<LoadState>({ identity, status: 'loading', error: null, attempts: [] });
  const [action, setAction] = useState<{ identity: object; status: 'pending' | 'uncertain'; error: string | null } | null>(null);
  const isCurrent = useCallback(() => mounted.current && currentIdentity.current === identity, [identity]);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoad((previous) => ({ identity, status: 'loading', error: null, attempts: previous.identity === identity ? previous.attempts : [] }));
    try {
      const detail = await getAgentRunDetail(identity);
      if (!isCurrent() || sequence !== requestSequence.current) return;
      dispatch({ type: 'replace-run-feed', resource: { backendConnectionId: detail.backendConnectionId, value: detail.value.run }, events: detail.value.events, interactions: detail.value.interactions });
      setLoad({ identity, status: 'ready', error: null, attempts: detail.value.attempts });
      setAction((previous) => previous?.identity === identity && previous.status === 'uncertain' ? null : previous);
      return true;
    } catch (error) {
      if (!isCurrent() || sequence !== requestSequence.current) return;
      setLoad((previous) => ({ ...previous, identity, status: 'error', error: error instanceof Error ? error.message : String(error) }));
    }
  }, [dispatch, identity, isCurrent]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; requestSequence.current += 1; };
  }, [refresh]);

  const performAction = async (operation: () => Promise<unknown>, label: string) => {
    if (actionInFlight.current === identity || !isCurrent()) return;
    // Reads started before the action cannot establish its outcome.
    requestSequence.current += 1;
    setLoad((previous) => ({ identity, status: 'ready', error: null, attempts: previous.identity === identity ? previous.attempts : [] }));
    actionInFlight.current = identity;
    setAction({ identity, status: 'pending', error: null });
    try {
      await operation();
      if (!isCurrent()) return;
      const refreshed = await refresh();
      if (isCurrent()) setAction(refreshed ? null : { identity, status: 'uncertain', error: null });
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      setAction({ identity, status: 'uncertain', error: `${label} could not be confirmed: ${message}. Check current status before sending again.` });
    } finally {
      if (actionInFlight.current === identity) actionInFlight.current = null;
    }
  };

  const resource = state.runs[agentResourceKey(identity)];
  const currentLoad = load.identity === identity ? load : null;
  const currentAction = action?.identity === identity ? action : null;
  const error = currentAction?.error ?? currentLoad?.error;
  const loading = !currentLoad || currentLoad.status === 'loading';
  const target = resource ? { identity, workspaceId: resource.value.workspaceId, parentNodeId: resource.value.parentNodeId } : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {(error || !resource) && (
        <div style={{ padding: 16, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>
          {error ? <div role="alert">{currentLoad?.error && !currentAction?.error ? `Could not load Agent Run details: ${error}` : error}</div> : <div role="status">Loading Agent Run…</div>}
          {error && <button type="button" style={statusButtonStyle} disabled={loading || currentAction?.status === 'pending'} onClick={() => { void refresh(); }}>Check current status</button>}
          {!resource && <button type="button" style={statusButtonStyle} aria-label="Close Run Pane" onClick={() => closePane(item.id)}>Close</button>}
        </div>
      )}
      {resource && target && <div style={{ flex: 1, minHeight: 0 }}><AgentRunPane
        run={resource}
        attempts={currentLoad?.attempts ?? []}
        events={state.eventsByRun[agentResourceKey(identity)] ?? []}
        interactions={state.interactionsByRun[agentResourceKey(identity)] ?? []}
        onClose={() => closePane(item.id)}
        onCancel={currentAction ? undefined : () => { void performAction(() => cancel(target, { version: 1, expectedAttemptId: resource.value.activeAttemptId, reason: null }), 'Cancellation'); }}
        onSendInput={currentAction ? undefined : (_, request) => { void performAction(() => sendInput(target, request), 'Input'); }}
        onRespondInteraction={currentAction ? undefined : (_, interaction, response) => { void performAction(() => respondAgentRunInteraction(target, interaction.id, { version: 1, response }), 'Interaction response'); }}
      /></div>}
    </div>
  );
}
