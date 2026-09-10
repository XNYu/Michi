import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinitionDtoV1, AgentRunDtoV1 } from 'michi-shared';
import { AgentDefinitionStatus, AgentRunCompletionMode, AgentRunInvocationMode, AgentRunStatus } from 'michi-shared';
import { locatedAgentResource } from '../../../state/agentIdentity';
import AgentLibraryPage from './AgentLibraryPage';

const hash = 'a'.repeat(64);
const contextPolicy = { version: 1 as const, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100_000 };
const permissionPolicy = { version: 1 as const, preset: 'research' as const, categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 };
const definition = (id: string, scope: 'global' | 'workspace', status: AgentDefinitionStatus): AgentDefinitionDtoV1 => ({ version: 1, id, ownerUserId: 'owner', scope, workspaceId: scope === 'workspace' ? 'workspace-1' : null, name: 'Reviewer', description: `${scope} reviewer`, instructions: 'Review carefully.', runtimeProfile: { version: 1, runtimeId: 'claude', providerId: 'anthropic', modelId: 'sonnet' }, fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy, contextPolicy, defaultRunTtlMs: null, status, revision: 1, createdAt: 1, updatedAt: 1 });
const run = (definitionId: string): AgentRunDtoV1 => ({ version: 1, id: `run-${definitionId}`, ownerUserId: 'owner', workspaceId: 'workspace-1', definitionId, definitionRevision: 1, effectiveDefinition: { version: 1, name: 'Reviewer', description: 'Reviews.', instructions: 'Review.', runtimeProfile: { version: 1, runtimeId: 'claude' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] }, permissionPolicy, contextPolicy }, invocationMode: AgentRunInvocationMode.Manual, completionMode: AgentRunCompletionMode.Detach, parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null, task: 'Review', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: 'workspace-1', snapshotHash: hash, createdAt: 1 }, status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: 'attempt', resultBundle: null, latestEventSeq: -1, createdAt: 1, startedAt: 1, completedAt: null, archivedAt: null, expiresAt: null });

describe('AgentLibraryPage', () => {
  it('keeps duplicate Global and Workspace names visibly separated', () => {
    render(<AgentLibraryPage definitions={[
      locatedAgentResource('remote-a', definition('workspace-reviewer', 'workspace', AgentDefinitionStatus.Draft)),
      locatedAgentResource('remote-a', definition('global-reviewer', 'global', AgentDefinitionStatus.Enabled)),
    ]} workspaceId="workspace-1" onCreate={() => {}} onEdit={() => {}} onEnable={() => {}} onDisable={() => {}} onDuplicate={() => {}} onDelete={() => {}} />);
    const workspace = screen.getByRole('region', { name: 'WORKSPACE AGENTS' });
    const global = screen.getByRole('region', { name: 'GLOBAL AGENTS' });
    expect(within(workspace).getByText('Reviewer')).not.toBeNull();
    expect(within(workspace).getByText('workspace')).not.toBeNull();
    expect(within(global).getByText('Reviewer')).not.toBeNull();
    expect(within(global).getByText('global')).not.toBeNull();
  });

  it('renders Draft/Enabled/Disabled actions and active Run counts', () => {
    const onEnable = vi.fn(); const onDisable = vi.fn(); const onDuplicate = vi.fn(); const onDelete = vi.fn();
    const resources = [
      locatedAgentResource('remote-a', { ...definition('draft', 'workspace', AgentDefinitionStatus.Draft), name: 'Draft Agent' }),
      locatedAgentResource('remote-a', { ...definition('enabled', 'workspace', AgentDefinitionStatus.Enabled), name: 'Enabled Agent' }),
      locatedAgentResource('remote-a', { ...definition('disabled', 'workspace', AgentDefinitionStatus.Disabled), name: 'Disabled Agent' }),
    ];
    render(<AgentLibraryPage definitions={resources} runs={[locatedAgentResource('remote-a', run('enabled'))]} workspaceId="workspace-1" onCreate={() => {}} onEdit={() => {}} onEnable={onEnable} onDisable={onDisable} onDuplicate={onDuplicate} onDelete={onDelete} />);
    expect(screen.getByText('draft')).not.toBeNull();
    expect(screen.getByText('enabled')).not.toBeNull();
    expect(screen.getByText('disabled')).not.toBeNull();
    expect(screen.getByText('1 active')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable Draft Agent' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disable Enabled Agent' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Enable Disabled Agent' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enable Draft Agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable Enabled Agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Disabled Agent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Draft Agent' }));
    expect(onEnable).toHaveBeenCalledWith({ backendConnectionId: 'remote-a', id: 'draft' });
    expect(onDisable).toHaveBeenCalledWith({ backendConnectionId: 'remote-a', id: 'enabled' });
    expect(onDuplicate).toHaveBeenCalledWith({ backendConnectionId: 'remote-a', id: 'disabled' });
    expect(onDelete).toHaveBeenCalledWith({ backendConnectionId: 'remote-a', id: 'draft' });
  });
});
