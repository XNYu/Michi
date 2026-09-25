import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentCapabilityCatalogEntryV1 } from 'michi-shared';
import AgentDefinitionForm, {
  createAgentDefinitionFormValue,
  validateAgentDefinitionForm,
} from './AgentDefinitionForm';
import AgentEditorPage from './AgentEditorPage';
import AgentRuntimeProfileFields, { catalogKey, emptyRuntimeProfileDraft, type RuntimeFieldCatalog } from './AgentRuntimeProfileFields';

const HASH = 'a'.repeat(64);

function catalogEntry(id: string, kind: AgentCapabilityCatalogEntryV1['kind'], readiness: AgentCapabilityCatalogEntryV1['readiness'] = 'ready'): AgentCapabilityCatalogEntryV1 {
  return {
    version: 1, id, kind, ownerUserId: 'owner', workspaceId: null, revision: 'rev-1', readiness,
    publicSchema: {}, publicConfig: {}, schemaHash: HASH, contentHash: null, configHash: HASH, credentialBindingIds: [],
  };
}

describe('Agent Definition editing — instructions optional + capability chips', () => {
  it('does not require instructions: a definition is [permissions, capabilities, when-to-use]', () => {
    const value = createAgentDefinitionFormValue(null, 'workspace', 'ws-1');
    const errors = validateAgentDefinitionForm({
      ...value, name: 'Source Critic', description: 'Cross-checks claims. Call after research.',
      runtimeProfile: { runtimeId: 'pi', providerId: 'openai', modelId: 'gpt', reasoning: '', modeId: '' },
      instructions: '',
    });
    expect(errors.instructions).toBeUndefined();
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it('renders selected refs as chips with readiness and flags unresolved ones', () => {
    const value = {
      ...createAgentDefinitionFormValue(null, 'workspace', 'ws-1'),
      toolRefs: 'web_search\nmissing-tool', skillRefs: 'web-research', mcpServerRefs: '',
    };
    const capabilities = [
      catalogEntry('web_search', 'tool'),
      catalogEntry('web-research', 'skill'),
      catalogEntry('citation-check', 'mcp_server', 'credential_required'),
    ];
    render(<AgentDefinitionForm value={value} onChange={() => {}} capabilities={capabilities} />);
    expect(screen.getAllByTestId('capability-chip')).toHaveLength(2);
    const unresolved = screen.getAllByTestId('capability-chip-unresolved');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].textContent).toContain('missing-tool');
    // The browse select offers only unselected entries, annotated with readiness.
    const select = screen.getByLabelText('add capability') as HTMLSelectElement;
    const options = [...select.options].map((option) => option.textContent);
    expect(options.some((text) => text?.includes('citation-check') && text.includes('credential required'))).toBe(true);
    expect(options.some((text) => text?.includes('web_search'))).toBe(false);
  });

  it('adds and removes capability refs through the picker', () => {
    const onChange = vi.fn();
    const value = { ...createAgentDefinitionFormValue(null, 'workspace', 'ws-1'), toolRefs: 'web_search' };
    render(<AgentDefinitionForm value={value} onChange={onChange}
      capabilities={[catalogEntry('web_search', 'tool'), catalogEntry('read_file', 'tool')]} />);
    fireEvent.change(screen.getByLabelText('add capability'), { target: { value: 'tool:read_file' } });
    expect(onChange.mock.calls.at(-1)?.[0].toolRefs).toBe('web_search\nread_file');
    fireEvent.click(screen.getByRole('button', { name: 'Remove capability web_search' }));
    expect(onChange.mock.calls.at(-1)?.[0].toolRefs).toBe('');
  });

  it('renders structured enable blockers as an actionable callout', () => {
    render(<AgentEditorPage initialScope="workspace" workspaceId="ws-1"
      error="capability tool:citation-check is credential_required"
      blockers={[
        { code: 'capability', ref: 'tool:citation-check', message: 'capability tool:citation-check is credential_required' },
        { code: 'runtime', ref: 'pi', message: 'provider openai requires a configured credential' },
      ]}
      onSaveDraft={() => {}} onEnable={() => {}} />);
    const callout = screen.getByTestId('enable-blockers');
    expect(callout.textContent).toContain('Cannot enable yet — 2 conditions');
    expect(callout.textContent).toContain('tool:citation-check');
    expect(callout.textContent).toContain('provider openai requires a configured credential');
  });
});

describe('AgentRuntimeProfileFields — dropdowns from the runtime catalog', () => {
  const catalog: RuntimeFieldCatalog = {
    runtimes: [
      { id: 'pi', label: 'Pi', available: true, requiresApiKey: true },
      { id: 'claude', label: 'Claude', available: true },
    ],
    providersFor: { pi: [{ id: 'anthropic', label: 'Anthropic', keyLabel: 'key', envVars: [], defaultModel: 'opus', supportsReasoning: true, hasKey: true }] },
    modelsFor: { [catalogKey('pi', 'anthropic')]: [{ id: 'opus-4-5', label: 'Opus 4.5' }] },
    request: vi.fn(),
  };

  it('offers runtimes, providers, and models as selects when the catalog is loaded', () => {
    const onChange = vi.fn();
    render(<AgentRuntimeProfileFields catalog={catalog} onChange={onChange}
      value={{ ...emptyRuntimeProfileDraft(), runtimeId: 'pi', providerId: 'anthropic' }} />);
    const runtime = screen.getByLabelText('runtime runtime') as HTMLSelectElement;
    expect(runtime.tagName).toBe('SELECT');
    expect([...runtime.options].map((option) => option.value)).toContain('claude');
    fireEvent.change(screen.getByLabelText('runtime provider'), { target: { value: 'anthropic' } });
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ providerId: 'anthropic', modelId: '' });
    const model = screen.getByLabelText('runtime model') as HTMLSelectElement;
    expect([...model.options].map((option) => option.value)).toContain('opus-4-5');
    // Switching runtime resets dependent provider/model selections.
    fireEvent.change(runtime, { target: { value: 'claude' } });
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ runtimeId: 'claude', providerId: '', modelId: '' });
    expect(catalog.request).toHaveBeenCalledWith('pi', 'anthropic');
  });

  it('falls back to text inputs when the catalog is unavailable', () => {
    render(<AgentRuntimeProfileFields catalog={null} onChange={() => {}} value={emptyRuntimeProfileDraft()} />);
    expect((screen.getByLabelText('runtime runtime') as HTMLElement).tagName).toBe('INPUT');
    expect((screen.getByLabelText('runtime model') as HTMLElement).tagName).toBe('INPUT');
  });
});
