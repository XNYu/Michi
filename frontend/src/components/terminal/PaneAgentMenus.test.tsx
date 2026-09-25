import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaneAgentMenus } from './PaneAgentMenus';

const status = {
  runtime: 'gemini',
  label: 'Gemini',
  capabilities: {
    modes: true,
    permissions: true,
    models: true,
    providerModels: false,
    reasoning: false,
    supportedReasoningLevels: [],
    apiKeys: false,
    warmSessions: true,
    saveContext: true,
    spawnBranches: true,
    nativeResume: true,
  },
  availableRuntimes: [],
  model: 'auto',
  hasRequiredKey: true,
};

const baseProps = {
  agentMenu: null,
  modelMenu: { x: 10, y: 10 },
  availableModes: [],
  agentStatus: status,
  resolvedBinding: { runtime: 'gemini', provider: undefined, model: 'auto', reasoning: undefined, source: 'global' as const },
  catalogCapabilities: null,
  providerModels: [],
  modelsLoading: false,
  modelsError: null,
  onSwitchAgent: vi.fn(),
  onSwitchRuntime: vi.fn(),
  onSaveModel: vi.fn(),
  onRetryModels: vi.fn(),
  onSaveReasoning: vi.fn(),
  onCloseAgentMenu: vi.fn(),
  onCloseModelMenu: vi.fn(),
};

describe('PaneAgentMenus model catalog states', () => {
  it('shows a loading row while models are being fetched', () => {
    render(<PaneAgentMenus {...baseProps} modelsLoading />);
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    expect(screen.getByText('Loading models…')).toBeTruthy();
  });

  it('shows the error and exposes a manual retry action', async () => {
    const onRetryModels = vi.fn();
    render(
      <PaneAgentMenus
        {...baseProps}
        modelsError="catalog unavailable"
        onRetryModels={onRetryModels}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
    expect(screen.getByText('catalog unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onRetryModels).toHaveBeenCalledTimes(1));
  });
});

describe('PaneAgentMenus default agent display', () => {
  const agentMenuProps = {
    ...baseProps,
    agentMenu: { x: 10, y: 10 } as const,
    modelMenu: null,
    availableModes: [
      { id: 'kiro_default', name: 'Kiro Default Agent' },
      { id: 'planner', name: 'Planner' },
    ],
    onSelectPrimaryAgent: vi.fn(),
    onSelectDefaultAgent: vi.fn(),
    primaryAgents: [],
  };

  // The selection mark is the trailing check glyph, not part of the label text.
  const isChecked = (label: string) => {
    const row = screen.getAllByRole('menuitem')
      .find((item) => item.querySelector('.michi-menu-label > span')?.textContent === label);
    return row?.querySelector('.michi-menu-glyph')?.textContent === '✓';
  };

  it('clears explicit selection through the default Agent action', async () => {
    const onSelectDefaultAgent = vi.fn();
    render(
      <PaneAgentMenus
        {...agentMenuProps}
        defaultModeId="kiro_default"
        runtimeId="kiro"
        onSelectDefaultAgent={onSelectDefaultAgent}
      />,
    );

    // The follow-default row comes first; the Kiro section lists the same agent by name.
    fireEvent.click(screen.getAllByText('Kiro Default Agent')[0]);
    await waitFor(() => expect(onSelectDefaultAgent).toHaveBeenCalledTimes(1));
  });

  it('does not mark follow-default selected when a specific runtime Agent is pinned', () => {
    render(
      <PaneAgentMenus
        {...agentMenuProps}
        defaultModeId="kiro_default"
        runtimeId="kiro"
        currentModeId="planner"
      />,
    );

    expect(isChecked('Kiro Default Agent')).toBe(false);
    expect(isChecked('Planner')).toBe(true);
  });

  it('does not mark follow-default selected when a custom primary Agent is selected', () => {
    render(
      <PaneAgentMenus
        {...agentMenuProps}
        defaultModeId="kiro_default"
        runtimeId="kiro"
        selectedPrimaryAgentId="some-custom-agent"
      />,
    );

    expect(isChecked('Kiro Default Agent')).toBe(false);
    expect(screen.getAllByText('Kiro Default Agent').length).toBeGreaterThanOrEqual(1);
  });
});

describe('PaneAgentMenus mode section header', () => {
  const withPrimaryAgents = {
    ...baseProps,
    agentMenu: { x: 10, y: 10 } as const,
    modelMenu: null,
    availableModes: [
      { id: 'kiro_default', name: 'Kiro Default Agent' },
      { id: 'planner', name: 'Planner' },
    ],
    onSelectPrimaryAgent: vi.fn(),
    onSelectDefaultAgent: vi.fn(),
    primaryAgents: [{
      id: 'agent-1',
      name: 'My Agent',
      scope: 'workspace' as const,
      runtimeSummary: 'pi · anthropic',
    }],
    defaultModeId: 'kiro_default',
  };

  it('omits the header when no primary agent callbacks are provided', () => {
    render(
      <PaneAgentMenus
        {...withPrimaryAgents}
        runtimeId="kiro"
        primaryAgents={[]}
        onSelectPrimaryAgent={undefined}
        onSelectDefaultAgent={undefined}
        agentStatus={{ ...status, runtime: 'kiro', label: 'Kiro' }}
      />,
    );
    expect(screen.queryByText('Kiro Agents')).toBeFalsy();
  });
});
