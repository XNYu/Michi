import { useEffect, useRef, useState } from 'react';
import { setCustomAgentsEnabled } from '../../../../services/api';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { broadcastAgentStatusChanged } from '../../../../state/agentStatusSync';
import { useChatStore } from '../../../../state/chatStore';
import { Row as ClickableRow } from '../../primitives';
import { Switch } from '../../../ui/controls';
import { Row } from './controls';

export function CustomAgentsPane() {
  const { activeProject, agentStatus, refreshAgentStatus } = useChatStore();
  const backendConnectionId = activeProject?.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID;
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const backendEnabled = agentStatus?.customAgentsEnabled === true;
  const enabled = pendingEnabled ?? backendEnabled;
  const unavailable = agentStatus == null;

  useEffect(() => {
    requestVersion.current += 1;
    setPendingEnabled(null);
    setSaving(false);
    setError(null);
    refreshAgentStatus();
  }, [backendConnectionId, refreshAgentStatus]);

  useEffect(() => {
    if (pendingEnabled === backendEnabled) setPendingEnabled(null);
  }, [backendEnabled, pendingEnabled]);

  const updateEnabled = async (next: boolean) => {
    if (saving || unavailable) return;
    const connectionId = backendConnectionId;
    const version = ++requestVersion.current;
    setSaving(true);
    setError(null);
    setPendingEnabled(next);
    try {
      const result = await setCustomAgentsEnabled(next, connectionId);
      broadcastAgentStatusChanged(connectionId);
      if (requestVersion.current !== version) return;
      setPendingEnabled(result.customAgentsEnabled);
      refreshAgentStatus();
    } catch (reason) {
      if (requestVersion.current !== version) return;
      setPendingEnabled(null);
      setError(reason instanceof Error ? reason.message : 'Failed to update Custom Agents');
    } finally {
      if (requestVersion.current === version) setSaving(false);
    }
  };

  return (
    <div>
      <h1
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--term-fg)',
          margin: 0,
        }}
      >
        Custom Agents
      </h1>
      <div style={{ marginBottom: 20 }} />

      <Row k="backend.customAgents" label="Custom Agents">
        <ClickableRow
          onClick={() => { void updateEnabled(!enabled); }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '4px 6px',
            margin: '0 -6px',
            cursor: saving || unavailable ? 'not-allowed' : 'pointer',
            opacity: unavailable ? 0.6 : 1,
          }}
        >
          <Switch
            on={enabled}
            disabled={saving || unavailable}
            onChange={(next) => { void updateEnabled(next); }}
            aria-label="Show Custom Agents"
          />
          <span style={{ fontSize: 11.5, color: 'var(--term-mid)', fontFamily: 'var(--ui-font)' }}>
            {saving ? 'Updating Custom Agents…' : 'Show Custom Agents'}
          </span>
        </ClickableRow>
        <p
          style={{
            margin: '8px 0 0',
            fontFamily: 'var(--ui-font)',
            fontSize: 10.5,
            lineHeight: 1.5,
            color: 'var(--term-muted)',
          }}
        >
          Controls Custom Agents on the active backend. Turning it off removes the UI entry and blocks Agent definitions, Runs, and Agent Run tools; saved definitions are retained.
        </p>
        {unavailable && (
          <p style={{ margin: '8px 0 0', fontSize: 10.5, color: 'var(--term-muted)' }}>
            Loading backend status…
          </p>
        )}
        {error && (
          <p role="alert" style={{ margin: '8px 0 0', fontSize: 10.5, color: 'var(--term-danger)' }}>
            {error}
          </p>
        )}
      </Row>
    </div>
  );
}
