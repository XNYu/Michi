// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '../services/api';

const fetchAgentStatus = vi.hoisted(() => vi.fn());

vi.mock('../services/api', () => ({
  fetchAgentStatus,
  saveAgentOptions: vi.fn(),
  saveProviderKey: vi.fn(),
  verifyProviderKey: vi.fn(),
}));

vi.mock('../state/prefs', () => ({
  usePrefs: () => ({
    prefs: { onboardingCompletedAt: '2026-01-01T00:00:00.000Z' },
  }),
}));

import ApiKeyGate from './ApiKeyGate';

const deepseek = {
  id: 'deepseek',
  label: 'DeepSeek',
  keyLabel: 'DeepSeek API key',
  envVars: ['DEEPSEEK_API_KEY'],
  defaultModel: 'deepseek-v4-flash',
  supportsReasoning: true,
  hasKey: true,
};

const cerebras = {
  id: 'cerebras',
  label: 'Cerebras',
  keyLabel: 'Cerebras API key',
  envVars: ['CEREBRAS_API_KEY'],
  defaultModel: 'gpt-oss-120b',
  supportsReasoning: true,
  hasKey: false,
};

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    runtime: 'pi',
    label: 'Pi',
    capabilities: {
      modes: false,
      permissions: false,
      providerModels: true,
      reasoning: true,
      apiKeys: true,
      warmSessions: false,
      saveContext: false,
      spawnBranches: false,
    },
    availableRuntimes: [{ id: 'pi', label: 'Pi', available: true, requiresApiKey: true }],
    provider: 'deepseek',
    providers: [deepseek, cerebras],
    model: 'deepseek-v4-flash',
    hasRequiredKey: true,
    ...overrides,
  };
}

describe('ApiKeyGate', () => {
  beforeEach(() => {
    fetchAgentStatus.mockReset();
    fetchAgentStatus.mockResolvedValue(status());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('opens on a non-silent reload even when another provider already has a key', async () => {
    fetchAgentStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        // Logged-in / BYOK: any saved key keeps hasRequiredKey true.
        hasRequiredKey: true,
      }));

    render(<ApiKeyGate />);
    await waitFor(() => expect(fetchAgentStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Add a provider key')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });

    expect(await screen.findByText('Add a provider key')).toBeTruthy();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('cerebras');
  });

  it('stays closed on a silent reload even when the new provider has no key', async () => {
    fetchAgentStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({
        provider: 'cerebras',
        model: 'gpt-oss-120b',
        hasRequiredKey: false,
      }));

    render(<ApiKeyGate />);
    await waitFor(() => expect(fetchAgentStatus).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('michi:reload-agent-status', { detail: { silent: true } }),
      );
    });

    await waitFor(() => expect(fetchAgentStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Add a provider key')).toBeNull();
  });
});
