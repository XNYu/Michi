import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentDefinitionStatus,
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunInvocationMode,
  AgentRunStatus,
  type AgentDefinitionDtoV1,
  type AgentRunDtoV1,
  type AgentRunEventV1,
} from 'michi-shared';
import type { LocatedAgentResource } from '../../../state/agentIdentity';
import { AgentRunActions } from './AgentRunActions';
import { AgentRunPane } from './AgentRunPane';

const HASH = 'c'.repeat(64);
const resultBundle: NonNullable<AgentRunDtoV1['resultBundle']> = {
  version: 1, status: 'completed', source: 'submitted',
  handoff: { conclusion: 'Complete', artifactsOrChanges: 'Changed one file', unresolvedIssues: '' },
  artifacts: [], resourceMutations: [], externalActions: [],
};

function located(backendConnectionId: string): LocatedAgentResource<AgentRunDtoV1> {
  return { backendConnectionId, value: {
    version: 1, id: 'same-run-id', ownerUserId: 'owner', workspaceId: 'ws',
    definitionId: null, definitionRevision: null,
    effectiveDefinition: {
      version: 1, name: 'Ephemeral Agent', description: 'A snapshot', instructions: 'Do the task',
      runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [],
      capabilitySnapshot: { version: 1, entries: [] },
      permissionPolicy: {
        version: 1, preset: 'research', categories: {}, maxDelegationDepth: 1,
        maxConcurrentRuns: 2, maxWallTimeMs: 60_000, maxAttempts: 2,
      },
      contextPolicy: {
        version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
        allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000,
      },
    },
    invocationMode: AgentRunInvocationMode.Manual,
    completionMode: AgentRunCompletionMode.Detach,
    parentRunId: null, parentAttemptId: null, parentNodeId: 'parent-node', parentTurnId: null,
    parentMessageId: 'parent-message', parentToolCallId: null, task: 'Inspect routing',
    contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 },
    expectedResult: null,
    executionEnvironment: {
      version: 1, kind: 'shared_workspace', cwd: '/tmp/ws', sourceWorkspaceId: 'ws',
      snapshotHash: HASH, createdAt: 1,
    },
    status: AgentRunStatus.Completed, waitingReason: null, activeAttemptId: null,
    resultBundle, latestEventSeq: 0, createdAt: 1, startedAt: 2, completedAt: 3,
    archivedAt: null, expiresAt: null,
  } };
}

const events: AgentRunEventV1[] = [{
  version: 1, runId: 'same-run-id', seq: 0, attemptId: null,
  type: AgentRunEventType.Assistant, payload: { text: 'selected transcript' }, createdAt: 2,
}];

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function draftDefinition(): AgentDefinitionDtoV1 {
  const snapshot = located('remote-a').value.effectiveDefinition;
  return {
    version: 1, id: 'definition-1', ownerUserId: 'owner', scope: 'workspace', workspaceId: 'ws',
    name: snapshot.name, description: snapshot.description, instructions: snapshot.instructions,
    runtimeProfile: snapshot.runtimeProfile, fallbackChain: snapshot.fallbackChain,
    toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: snapshot.permissionPolicy,
    contextPolicy: snapshot.contextPolicy, defaultRunTtlMs: null,
    status: AgentDefinitionStatus.Draft, revision: 1, createdAt: 10, updatedAt: 10,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('AgentRunActions', () => {
  it('sends explicit task/result/transcript choices only to the selected composite Backend identity', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({
      version: 1, runId: 'same-run-id', workspaceId: 'ws', nodeId: 'child-node',
      treeId: 'tree-1', parentNodeId: 'parent-node', mode: 'branch',
      imported: { task: true, result: false, transcript: true },
    }, 201));
    vi.stubGlobal('fetch', fetch);
    render(<AgentRunActions run={located('remote-a')} events={events} />);

    fireEvent.click(screen.getByLabelText('result'));
    fireEvent.click(screen.getByLabelText('transcript'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue as Branch' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/backend-connections/remote-a/proxy/agent-runs/same-run-id/continue-as-branch');
    expect(url).not.toContain('/backend-connections/local/');
    expect(JSON.parse(String(init.body))).toEqual({
      version: 1, workspaceId: 'ws', includeTask: true,
      includeResult: false, includeTranscript: true, fallback: 'error',
    });
    expect((init.headers as Record<string, string>)['x-idempotency-key']).toBeTruthy();
    expect(screen.getByText('Branch created: child-node')).not.toBeNull();
  });

  it('offers the explicit new-thread fallback after a missing Parent response', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'parent_unavailable', message: 'Parent missing; continue as a new thread.' }, 400))
      .mockResolvedValueOnce(jsonResponse({
        version: 1, runId: 'same-run-id', workspaceId: 'ws', nodeId: 'root-node',
        treeId: 'new-tree', parentNodeId: null, mode: 'new_thread',
        imported: { task: true, result: true, transcript: false },
      }, 201));
    vi.stubGlobal('fetch', fetch);
    render(<AgentRunActions run={located('remote-a')} />);

    fireEvent.click(screen.getByRole('button', { name: 'Continue as Branch' }));
    const fallback = await screen.findByRole('button', { name: 'Continue as new thread' });
    fireEvent.click(fallback);
    await screen.findByText('New thread created: root-node');
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body)).fallback).toBe('new_thread');
  });

  it('saves an ephemeral snapshot as a Draft through the selected Backend endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ version: 1, runId: 'same-run-id', definition: draftDefinition() }, 201));
    vi.stubGlobal('fetch', fetch);
    const run = located('remote-save');
    const before = JSON.stringify(run.value.effectiveDefinition);
    render(<AgentRunActions run={run} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save as Custom Agent' }));
    await screen.findByText('Draft saved: Ephemeral Agent');
    expect(fetch.mock.calls[0][0]).toContain('/backend-connections/remote-save/proxy/agent-runs/same-run-id/save-as-agent');
    expect(JSON.stringify(run.value.effectiveDefinition)).toBe(before);
  });

  it('is actually mounted in the terminal Result area of AgentRunPane', () => {
    render(<AgentRunPane run={located('remote-pane')} events={events} onClose={() => {}} />);
    expect(screen.getByTestId('agent-run-actions')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Continue as Branch' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Save as Custom Agent' })).not.toBeNull();
  });
});
