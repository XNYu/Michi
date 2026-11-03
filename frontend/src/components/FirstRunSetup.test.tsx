import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '../services/api';

const mocks = vi.hoisted(() => ({
  store: { agentStatus: null as AgentStatus | null, hydrated: true, projects: [] as unknown[], refreshAgentStatus: vi.fn() },
  prefs: { onboardingCompletedAt: null as number | null },
  setPref: vi.fn(), save: vi.fn(), catalog: vi.fn(),
}));
vi.mock('../state/chatStore', () => ({ useChatStore: () => mocks.store }));
vi.mock('../state/prefs', () => ({ usePrefs: () => ({ prefs: mocks.prefs, setPref: mocks.setPref }) }));
vi.mock('../services/api', () => ({ saveAgentOptions: mocks.save }));
vi.mock('../hooks/useAgentModelCatalog', () => ({ useAgentModelCatalog: mocks.catalog }));
import FirstRunSetup from './FirstRunSetup';

function status(runtime = '', needsKey = false): AgentStatus {
  return {
    runtime, label: runtime, hasRequiredKey: !needsKey,
    capabilities: { modes: false, permissions: false, models: true, providerModels: needsKey,
      reasoning: false, supportedReasoningLevels: [], apiKeys: needsKey, warmSessions: false,
      saveContext: false, spawnBranches: false, nativeResume: false },
    availableRuntimes: [
      { id: 'kiro', label: 'Kiro', available: false },
      { id: 'pi', label: 'Pi', available: true, requiresApiKey: true },
      { id: 'codex', label: 'Codex', available: true },
      { id: 'claude', label: 'Claude', available: true },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.agentStatus = status();
  mocks.store.projects = [];
  mocks.store.hydrated = true;
  mocks.prefs.onboardingCompletedAt = null;
  mocks.save.mockResolvedValue({ ok: true });
  mocks.catalog.mockReturnValue({ models: [], loading: false, error: null });
});
afterEach(cleanup);

describe('FirstRunSetup', () => {
  it('starts without a recommendation or preselection and sorts available choices by name', () => {
    render(<FirstRunSetup />);
    expect(screen.queryByText(/recommended/i)).toBeNull();
    expect(screen.queryByText('Kiro')).toBeNull();
    const choices = screen.getAllByRole('button', { pressed: false });
    expect(choices.map(button => button.textContent?.split('Uses')[0].split('Bring')[0])).toEqual(['Claude', 'Codex', 'Pi']);
    expect((screen.getByRole('button', { name: 'Choose a runtime' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mocks.setPref).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('waits for saved selection and refreshed status before completing without Kiro', async () => {
    const view = render(<FirstRunSetup />);
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }));
    await waitFor(() => expect(mocks.store.refreshAgentStatus).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith({ runtime: 'codex' });
    expect((screen.getByRole('button', { name: 'Choose a runtime' }) as HTMLButtonElement).disabled).toBe(true);
    mocks.store.agentStatus = status('codex');
    view.rerender(<FirstRunSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'Start with Codex →' }));
    expect(mocks.setPref).toHaveBeenCalledWith('onboardingCompletedAt', expect.any(Number));
  });

  it.each(['response', 'network'])('shows a %s save failure and allows a retry', async (failure) => {
    if (failure === 'response') mocks.save.mockResolvedValueOnce({ ok: false, error: 'Selection failed' });
    else mocks.save.mockRejectedValueOnce(new Error('Selection failed'));
    render(<FirstRunSetup />);
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Selection failed');
    expect(mocks.setPref).not.toHaveBeenCalled();
    expect(mocks.store.refreshAgentStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Codex/ }));
    await waitFor(() => expect(mocks.store.refreshAgentStatus).toHaveBeenCalledOnce());
  });

  it('hands a chosen API runtime to key setup', () => {
    mocks.store.agentStatus = status('pi', true);
    render(<FirstRunSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up Pi key →' }));
    expect(mocks.setPref).toHaveBeenCalledWith('onboardingCompletedAt', expect.any(Number));
  });

  it('does not allow a stale unavailable runtime to complete setup', () => {
    mocks.store.agentStatus = status('kiro');
    render(<FirstRunSetup />);
    expect((screen.getByRole('button', { name: 'Choose a runtime' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Start with Kiro/)).toBeNull();
  });

  it('offers refresh when no runtimes are available', () => {
    mocks.store.agentStatus = { ...status(), availableRuntimes: [] };
    render(<FirstRunSetup />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh runtimes' }));
    expect(mocks.store.refreshAgentStatus).toHaveBeenCalledOnce();
  });

  it('preserves existing users and waits for hydration', () => {
    mocks.store.hydrated = false;
    const view = render(<FirstRunSetup />);
    expect(mocks.setPref).not.toHaveBeenCalled();
    mocks.store.hydrated = true;
    mocks.store.projects = [{ id: 'existing' }];
    view.rerender(<FirstRunSetup />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.setPref).toHaveBeenCalledWith('onboardingCompletedAt', expect.any(Number));
  });
});
