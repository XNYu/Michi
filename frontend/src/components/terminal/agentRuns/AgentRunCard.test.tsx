import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRunCompletionMode, AgentRunInvocationMode, AgentRunStatus, AgentRunWaitingReason,
  type AgentRunAttemptDtoV1, type AgentRunDtoV1,
} from 'michi-shared';
import { AgentRunCard } from './AgentRunCard';
import type { LocatedAgentResource } from '../../../state/agentIdentity';

const HASH = 'a'.repeat(64);
function run(status: AgentRunStatus, overrides: Partial<AgentRunDtoV1> = {}): LocatedAgentResource<AgentRunDtoV1> {
  const terminal = [AgentRunStatus.Completed, AgentRunStatus.Failed, AgentRunStatus.Cancelled].includes(status);
  return { backendConnectionId: 'remote-a', value: {
    version: 1, id: `run-${status}`, ownerUserId: 'owner', workspaceId: 'ws',
    definitionId: null, definitionRevision: null,
    effectiveDefinition: { version: 1, name: 'Snapshot Implementer', description: 'Builds', instructions: 'Build',
      runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'google', modelId: 'gemini' }, fallbackChain: [],
      capabilitySnapshot: { version: 1, entries: [] },
      permissionPolicy: { version: 1, preset: 'build', categories: {}, maxDelegationDepth: 1, maxConcurrentRuns: 2, maxWallTimeMs: 1000, maxAttempts: 2 },
      contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 } },
    invocationMode: AgentRunInvocationMode.Manual, completionMode: AgentRunCompletionMode.Detach,
    parentRunId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null, parentAttemptId: null,
    task: 'Implement authentication', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null, executionEnvironment: { version: 1, kind: 'git_worktree', cwd: '/tmp/run', sourceWorkspaceId: 'ws', baseCommit: 'abc', snapshotHash: HASH, createdAt: 1 },
    status, waitingReason: status === AgentRunStatus.Waiting ? AgentRunWaitingReason.Permission : null, activeAttemptId: null,
    resultBundle: terminal ? { version: 1, status: status === AgentRunStatus.Completed ? 'completed' : status === AgentRunStatus.Cancelled ? 'cancelled' : 'failed', source: 'submitted', handoff: { conclusion: `${status} conclusion`, artifactsOrChanges: '', unresolvedIssues: '' }, artifacts: [], resourceMutations: [], externalActions: [] } : null,
    latestEventSeq: 0, createdAt: 1000, startedAt: 1000, completedAt: terminal ? 2000 : null, archivedAt: null, expiresAt: null,
    ...overrides,
  } };
}

describe('AgentRunCard', () => {
  it.each([
    AgentRunStatus.Running, AgentRunStatus.Waiting, AgentRunStatus.Completed, AgentRunStatus.Failed,
  ])('renders %s state from the durable Run snapshot', (status) => {
    render(<AgentRunCard run={run(status)} now={3000} onOpen={() => {}} />);
    expect(screen.getByText(status)).not.toBeNull();
    expect(screen.getByText('Snapshot Implementer')).not.toBeNull();
  });

  it('shows recovery subtly and opens with a composite identity', () => {
    const onOpen = vi.fn();
    const attempts: AgentRunAttemptDtoV1[] = [0, 1].map((attemptIndex) => ({
      version: 1, id: `attempt-${attemptIndex}`, runId: 'run-running', attemptIndex,
      profileIndex: attemptIndex, runtimeProfile: { version: 1, runtimeId: 'pi' },
      status: attemptIndex ? 'running' : 'failed', publicSessionId: `session-${attemptIndex}`,
      recoveryEnvelope: null, startedAt: 1000, checkpointAt: null,
      completedAt: attemptIndex ? null : 1200, error: null,
    }));
    render(<AgentRunCard run={run(AgentRunStatus.Running)} attempts={attempts} onOpen={onOpen} />);
    expect(screen.getByText('Recovered automatically')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open →' }));
    expect(onOpen).toHaveBeenCalledWith({ backendConnectionId: 'remote-a', id: 'run-running' });
  });

  it('uses compact handoff only for terminal cards', () => {
    render(<AgentRunCard run={run(AgentRunStatus.Completed)} onOpen={() => {}} />);
    expect(screen.getByTestId('compact-handoff').textContent).toContain('completed conclusion');
    expect(screen.queryByText('raw transcript detail')).toBeNull();
  });
});
