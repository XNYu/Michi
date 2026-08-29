import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinitionDtoV1 } from 'michi-shared';
import { AgentDefinitionStatus } from 'michi-shared';
import { locatedAgentResource } from '../../../state/agentIdentity';
import AgentEditorPage from './AgentEditorPage';

const contextPolicy = { version: 1 as const, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100_000 };
const permissionPolicy = { version: 1 as const, preset: 'research' as const, categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 };
const enabledDefinition: AgentDefinitionDtoV1 = { version: 1, id: 'enabled-agent', ownerUserId: 'owner', scope: 'global', workspaceId: null, name: 'Enabled Agent', description: 'Does enabled work.', instructions: 'Work.', runtimeProfile: { version: 1, runtimeId: 'claude' }, fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy, contextPolicy, defaultRunTtlMs: null, status: AgentDefinitionStatus.Enabled, revision: 2, createdAt: 1, updatedAt: 2 };

describe('AgentEditorPage', () => {
  it('allows invalid profile/fallback/permission data to save as Draft but blocks Enable', () => {
    const onSaveDraft = vi.fn(); const onEnable = vi.fn();
    render(<AgentEditorPage initialScope="workspace" workspaceId="workspace-1" onSaveDraft={onSaveDraft} onEnable={onEnable} />);
    const enable = screen.getByRole('button', { name: 'Enable' }) as HTMLButtonElement;
    const save = screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(save.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '+ add fallback profile' }));
    fireEvent.change(screen.getByLabelText('max attempts'), { target: { value: '0' } });
    expect(screen.getAllByRole('alert').some((element) => element.textContent?.includes('Fallback runtime'))).toBe(true);
    expect(enable.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSaveDraft).toHaveBeenCalledOnce();
    expect(onEnable).not.toHaveBeenCalled();
  });

  it('rejects invalid TTL and round-trips bounded and indefinite retention through Draft save', async () => {
    const onSaveDraft = vi.fn();
    render(<AgentEditorPage initialScope="workspace" workspaceId="workspace-1" onSaveDraft={onSaveDraft} onEnable={() => {}} />);
    fireEvent.click(screen.getByLabelText('Bounded default'));
    const ttl = screen.getByLabelText('default run TTL milliseconds');
    fireEvent.change(ttl, { target: { value: '100' } });
    expect(screen.getByText(/TTL must be/)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(ttl, { target: { value: '60000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(onSaveDraft.mock.calls.at(-1)?.[0]).toMatchObject({ retention: 'bounded', defaultRunTtlMs: '60000' });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save Draft' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByLabelText('Indefinite'));
    expect(screen.queryByLabelText('default run TTL milliseconds')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(onSaveDraft.mock.calls.at(-1)?.[0]).toMatchObject({ retention: 'indefinite', defaultRunTtlMs: '' });
  });

  it('shows explicit actions for an enabled saved Definition', async () => {
    const onDisable = vi.fn(); const onDuplicate = vi.fn(); const onDelete = vi.fn();
    render(<AgentEditorPage definition={locatedAgentResource('remote-a', enabledDefinition)} onSaveDraft={() => {}} onEnable={() => {}} onDisable={onDisable} onDuplicate={onDuplicate} onDelete={onDelete} />);
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const identity = { backendConnectionId: 'remote-a', id: 'enabled-agent' };
    expect(onDisable).toHaveBeenCalledWith(identity);
    expect(onDuplicate).toHaveBeenCalledWith(identity);
    expect(onDelete).toHaveBeenCalledWith(identity);
  });
});
