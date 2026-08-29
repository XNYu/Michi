import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRunCompletionMode, AgentRunEventType, AgentRunInvocationMode, AgentRunStatus,
  type AgentRunAttemptDtoV1, type AgentRunDtoV1, type AgentRunEventV1,
  type AgentRunInteractionDtoV1,
} from 'michi-shared';
import type { LocatedAgentResource } from '../../../state/agentIdentity';
import { AgentRunCard } from './AgentRunCard';
import { AgentRunPane } from './AgentRunPane';

const HASH = 'b'.repeat(64);
const resource: LocatedAgentResource<AgentRunDtoV1> = { backendConnectionId: 'remote-b', value: {
  version: 1, id: 'run-pane', ownerUserId: 'owner', workspaceId: 'ws', definitionId: null, definitionRevision: null,
  effectiveDefinition: { version: 1, name: 'Deleted Definition Snapshot', description: 'Works', instructions: 'Work',
    runtimeProfile: { version: 1, runtimeId: 'claude', modelId: 'sonnet' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: { version: 1, preset: 'build', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 2, maxWallTimeMs: 1000, maxAttempts: 2 },
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 } },
  invocationMode: AgentRunInvocationMode.Manual, completionMode: AgentRunCompletionMode.Detach,
  parentRunId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null, parentAttemptId: null,
  task: 'Inspect the code', contextManifest: { version: 1, entries: [{ kind: 'summary', label: 'Brief', content: 'Context', sha256: HASH }], assembledAt: 1, estimatedChars: 7 },
  expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: 'ws', snapshotHash: HASH, createdAt: 1 },
  status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: 'attempt-1', resultBundle: null,
  latestEventSeq: 1, createdAt: 1, startedAt: 2, completedAt: null, archivedAt: null, expiresAt: null,
} };
const attempt: AgentRunAttemptDtoV1 = { version: 1, id: 'attempt-1', runId: 'run-pane', attemptIndex: 0, profileIndex: 0,
  runtimeProfile: { version: 1, runtimeId: 'claude', modelId: 'sonnet' }, status: 'running', publicSessionId: 'session', recoveryEnvelope: null,
  startedAt: 2, checkpointAt: null, completedAt: null, error: null };
const events: AgentRunEventV1[] = [{ version: 1, runId: 'run-pane', seq: 0, attemptId: 'attempt-1',
  type: AgentRunEventType.Assistant, payload: { text: 'FULL TRANSCRIPT DETAIL' }, createdAt: 3 }];
const pending: AgentRunInteractionDtoV1 = { version: 1, id: 'interaction-1', runId: 'run-pane', attemptId: 'attempt-1',
  kind: 'permission', status: 'pending', request: { tool: 'bash' }, response: null, createdAt: 4, resolvedAt: null };

describe('AgentRunPane', () => {
  it('renders the delegated task as the first message and opens agent metadata from the header', () => {
    render(<AgentRunPane run={resource} attempts={[attempt]} events={events} onClose={() => {}} />);
    expect(screen.getByTestId('run-task').textContent).toContain('Inspect the code');
    expect(screen.queryByTestId('run-metadata-popover')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Agent metadata' }));
    const popover = screen.getByTestId('run-metadata-popover');
    expect(popover.textContent).toContain('build preset');
    expect(popover.textContent).toContain('shared workspace');
    expect(popover.textContent).toContain('context · 1 items · immutable');
    fireEvent.click(screen.getByRole('button', { name: 'Agent metadata' }));
    expect(screen.queryByTestId('run-metadata-popover')).toBeNull();
  });

  it('keeps full transcript in the Pane while the Parent card remains compact', () => {
    const { rerender } = render(<AgentRunCard run={resource} onOpen={() => {}} />);
    expect(screen.queryByText('FULL TRANSCRIPT DETAIL')).toBeNull();
    rerender(<AgentRunPane run={resource} attempts={[attempt]} events={events} onClose={() => {}} />);
    expect(screen.getByText('FULL TRANSCRIPT DETAIL')).not.toBeNull();
    expect(screen.getByText('Deleted Definition Snapshot')).not.toBeNull();
  });

  it('queues steering by default and exposes immediate stop as a distinct action', () => {
    const send = vi.fn();
    render(<AgentRunPane run={resource} attempts={[attempt]} onClose={() => {}} onSendInput={send} />);
    const input = screen.getByLabelText('Steer Agent Run');
    fireEvent.change(input, { target: { value: 'Continue safely' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue input' }));
    expect(send).toHaveBeenLastCalledWith(
      { backendConnectionId: 'remote-b', id: 'run-pane' },
      { version: 1, text: 'Continue safely', mode: 'queued', expectedAttemptId: 'attempt-1' },
    );
    fireEvent.change(input, { target: { value: 'Redirect now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop & redirect' }));
    expect(send.mock.calls.at(-1)?.[1].mode).toBe('immediate');
  });

  it('removes pending actions after interaction resolution and closes by composite identity', () => {
    const close = vi.fn();
    const respond = vi.fn();
    const { rerender } = render(<AgentRunPane run={resource} interactions={[pending]} onClose={close} onRespondInteraction={respond} />);
    expect(screen.getByTestId('pending-interaction-actions')).not.toBeNull();
    rerender(<AgentRunPane run={resource} interactions={[{ ...pending, status: 'resolved', response: { decision: 'allow' }, resolvedAt: 5 }]} onClose={close} onRespondInteraction={respond} />);
    expect(screen.queryByTestId('pending-interaction-actions')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close Run Pane' }));
    expect(close).toHaveBeenCalledWith({ backendConnectionId: 'remote-b', id: 'run-pane' });
  });
});
