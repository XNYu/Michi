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
  providerModels: [],
  modelsLoading: false,
  modelsError: null,
  onSwitchAgent: vi.fn(),
  onSaveModel: vi.fn(),
  onRetryModels: vi.fn(),
  onSaveReasoning: vi.fn(),
  onCloseAgentMenu: vi.fn(),
  onCloseModelMenu: vi.fn(),
};

describe('PaneAgentMenus model catalog states', () => {
  it('shows a loading row while models are being fetched', () => {
    render(<PaneAgentMenus {...baseProps} modelsLoading />);
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

    expect(screen.getByText('catalog unavailable')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(onRetryModels).toHaveBeenCalledTimes(1));
  });
});
