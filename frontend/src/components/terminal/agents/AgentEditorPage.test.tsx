import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilities, AgentDefinitionDtoV1 } from 'michi-shared';
import { AgentDefinitionStatus } from 'michi-shared';
import { locatedAgentResource } from '../../../state/agentIdentity';
import AgentEditorPage from './AgentEditorPage';

afterEach(() => vi.unstubAllGlobals());

const runtimeCapabilities: AgentCapabilities = {
  modes: false, permissions: true, models: true, providerModels: false,
  reasoning: true, supportedReasoningLevels: ['low', 'high', 'max'],
  apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false,
};
const catalogRuntimes = [{ id: 'claude', label: 'Claude', available: true }, { id: 'codex', label: 'Codex', available: true }];
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const editorActions = () => within(screen.getByLabelText('Agent editor actions'));
const actionButton = (name: string) => editorActions().getByRole('button', { name }) as HTMLButtonElement;
const submitAction = async (name: string) => {
  const button = actionButton(name);
  await act(async () => { fireEvent.click(button); });
  expect(button.disabled).toBe(false);
};

beforeEach(() => {
  // Every mounted editor probes its own Backend. These form/action tests must
  // not depend on a developer backend or leave network work beyond the test.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/agent-capabilities')) return jsonResponse({ capabilities: [] });
    if (path.endsWith('/agent/status')) return jsonResponse({ runtime: 'claude', label: 'Claude', capabilities: runtimeCapabilities, availableRuntimes: catalogRuntimes, hasRequiredKey: true });
    if (path.endsWith('/agent/runtime-catalog')) return jsonResponse({ providers: [], models: [{ id: 'model', isDefault: true, supportedReasoningLevels: ['high'] }], capabilities: runtimeCapabilities });
    throw new Error(`Unexpected Agent editor request: ${url}`);
  }));
});

const contextPolicy = { version: 1 as const, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100_000 };
const permissionPolicy = { version: 1 as const, preset: 'research' as const, categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 };
const enabledDefinition: AgentDefinitionDtoV1 = { version: 1, id: 'enabled-agent', ownerUserId: 'owner', scope: 'global', workspaceId: null, name: 'Enabled Agent', description: 'Does enabled work.', instructions: 'Work.', runtimeProfile: { version: 1, runtimeId: 'claude' }, fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy, contextPolicy, defaultRunTtlMs: null, status: AgentDefinitionStatus.Enabled, revision: 2, createdAt: 1, updatedAt: 2 };

describe('AgentEditorPage', () => {
  it('allows invalid profile/fallback/permission data to save as Draft but blocks Enable', async () => {
    const onSaveDraft = vi.fn(); const onEnable = vi.fn();
    render(<AgentEditorPage initialScope="workspace" workspaceId="workspace-1" onSaveDraft={onSaveDraft} onEnable={onEnable} />);
    const enable = actionButton('Enable');
    const save = actionButton('Save Draft');
    expect(enable.disabled).toBe(true);
    expect(save.disabled).toBe(false);
    fireEvent.click(screen.getByText('+ add fallback profile', { selector: 'button' }));
    fireEvent.change(screen.getByLabelText('max attempts'), { target: { value: '0' } });
    expect(within(screen.getByLabelText('Agent definition')).getAllByRole('alert').some((element) => element.textContent?.includes('Fallback runtime'))).toBe(true);
    expect(enable.disabled).toBe(true);
    await submitAction('Save Draft');
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
    expect(actionButton('Save Draft').disabled).toBe(true);
    fireEvent.change(ttl, { target: { value: '60000' } });
    await submitAction('Save Draft');
    expect(onSaveDraft.mock.calls.at(-1)?.[0]).toMatchObject({ retention: 'bounded', defaultRunTtlMs: '60000' });
    fireEvent.click(screen.getByLabelText('Indefinite'));
    expect(screen.queryByLabelText('default run TTL milliseconds')).toBeNull();
    await submitAction('Save Draft');
    expect(onSaveDraft.mock.calls.at(-1)?.[0]).toMatchObject({ retention: 'indefinite', defaultRunTtlMs: '' });
  });

  it('shows explicit actions for an enabled saved Definition', async () => {
    const onDisable = vi.fn(); const onDuplicate = vi.fn(); const onDelete = vi.fn();
    render(<AgentEditorPage definition={locatedAgentResource('remote-a', enabledDefinition)} onSaveDraft={() => {}} onEnable={() => {}} onDisable={onDisable} onDuplicate={onDuplicate} onDelete={onDelete} />);
    expect(editorActions().queryByRole('button', { name: 'Enable' })).toBeNull();
    await submitAction('Disable');
    await submitAction('Duplicate');
    await submitAction('Delete');
    const identity = { backendConnectionId: 'remote-a', id: 'enabled-agent' };
    expect(onDisable).toHaveBeenCalledWith(identity);
    expect(onDuplicate).toHaveBeenCalledWith(identity);
    expect(onDelete).toHaveBeenCalledWith(identity);
  });
});

it('keeps a new global draft catalog bound to the route Backend while that route changes', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/agent-capabilities')) return jsonResponse({ capabilities: [] });
    const runtime = url.includes('editor-scope-a') ? 'editor-runtime-a' : 'editor-runtime-b';
    return jsonResponse({ runtime, label: runtime, capabilities: { ...runtimeCapabilities, reasoning: false }, availableRuntimes: [{ id: runtime, label: runtime, available: true }], hasRequiredKey: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  const view = render(<AgentEditorPage initialScope="global" backendConnectionId="editor-scope-a" onSaveDraft={() => {}} onEnable={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText('runtime runtime').tagName).toBe('SELECT'));
  expect(within(screen.getByLabelText('runtime runtime')).getByText('editor-runtime-a', { selector: 'option' })).toBeTruthy();
  view.rerender(<AgentEditorPage initialScope="global" backendConnectionId="editor-scope-b" onSaveDraft={() => {}} onEnable={() => {}} />);
  await waitFor(() => expect(within(screen.getByLabelText('runtime runtime')).queryByText('editor-runtime-b', { selector: 'option' })).toBeTruthy());
  expect(within(screen.getByLabelText('runtime runtime')).queryByText('editor-runtime-a', { selector: 'option' })).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url.includes('editor-scope-a/proxy/agent-capabilities'))).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => url.includes('editor-scope-b/proxy/agent-capabilities'))).toBe(true);
});

it('blocks Enable for known unsupported primary and fallback reasoning while preserving Draft save', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/agent-capabilities')) return jsonResponse({ capabilities: [] });
    if (url.includes('/runtime-catalog')) return jsonResponse({ providers: [], models: [{ id: 'model', supportedReasoningLevels: ['high'] }], capabilities: runtimeCapabilities });
    return jsonResponse({ runtime: 'claude', label: 'Claude', capabilities: runtimeCapabilities, availableRuntimes: catalogRuntimes, hasRequiredKey: true });
  }));
  const onSaveDraft = vi.fn();
  const onEnable = vi.fn();
  const draft: AgentDefinitionDtoV1 = {
    ...enabledDefinition, id: 'reasoning-draft', status: AgentDefinitionStatus.Draft,
    runtimeProfile: { version: 1, runtimeId: 'claude', modelId: 'model', reasoning: 'max' },
    fallbackChain: [{ version: 1, runtimeId: 'codex', modelId: 'model', reasoning: 'max' }],
  };
  render(<AgentEditorPage definition={locatedAgentResource('reasoning-editor', draft)} onSaveDraft={onSaveDraft} onEnable={onEnable} />);
  const enable = actionButton('Enable');
  await waitFor(() => expect(screen.getAllByText(/Reasoning level max is unavailable/)).toHaveLength(2));
  expect(enable.disabled).toBe(true);
  await submitAction('Save Draft');
  expect(onSaveDraft).toHaveBeenCalledWith(expect.objectContaining({ runtimeProfile: expect.objectContaining({ reasoning: 'max' }), fallbackChain: [expect.objectContaining({ reasoning: 'max' })] }));
  fireEvent.change(screen.getByLabelText('runtime reasoning'), { target: { value: 'high' } });
  expect(enable.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('fallback 1 reasoning'), { target: { value: 'high' } });
  expect(enable.disabled).toBe(false);
  await submitAction('Enable');
  expect(onEnable).toHaveBeenCalledOnce();
});
