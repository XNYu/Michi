import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../../../../state/prefs';
import { ModelPane } from './ModelPane';

const setPref = vi.fn();
const refreshAgentStatus = vi.fn();
const saveAgentOptions = vi.hoisted(() => vi.fn());
const saveWebSearchKey = vi.hoisted(() => vi.fn());
const clearWebSearchKey = vi.hoisted(() => vi.fn());
let agentStatus: any = null;

vi.mock('../../../../state/chatStore', () => ({
  useChatStore: () => ({ agentStatus, refreshAgentStatus }),
}));

vi.mock('../../../../services/api', () => ({
  saveAgentOptions,
  saveWebSearchKey,
  clearWebSearchKey,
}));

vi.mock('../../../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../../state/prefs')>('../../../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({ prefs: actual.DEFAULT_PREFS, setPref }),
  };
});

describe('ModelPane Kiro sidecar title setting', () => {
  beforeEach(() => {
    setPref.mockClear();
    refreshAgentStatus.mockClear();
    saveAgentOptions.mockReset().mockResolvedValue({ ok: true });
    saveWebSearchKey.mockReset().mockResolvedValue({ ok: true });
    clearWebSearchKey.mockReset().mockResolvedValue({ ok: true });
    agentStatus = null;
  });

  function nativeResumeStatus(runtime = 'codex') {
    return { runtime, label: runtime === 'codex' ? 'Codex' : 'Claude',
      capabilities: { nativeResume: true }, availableRuntimes: [], hasRequiredKey: true,
      nativeResumeByRuntime: { codex: true, claude: false } };
  }

  it('saves Native Resume for only the selected runtime and restores each runtime value', async () => {
    agentStatus = nativeResumeStatus();
    const { rerender } = render(<ModelPane activeProjectId={null} />);
    const toggle = screen.getByRole('switch', { name: 'Native Resume for Codex' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ nativeResumeByRuntime: { codex: false } }));
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    agentStatus = nativeResumeStatus('claude');
    rerender(<ModelPane activeProjectId={null} />);
    const claudeToggle = screen.getByRole('switch', { name: 'Native Resume for Claude' });
    expect(claudeToggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(claudeToggle);
    await waitFor(() => expect(saveAgentOptions).toHaveBeenLastCalledWith({ nativeResumeByRuntime: { claude: true } }));
  });

  it('keeps the saved setting on failure and supports retry', async () => {
    agentStatus = nativeResumeStatus();
    saveAgentOptions.mockResolvedValueOnce({ ok: false, error: 'Unable to persist preference' });
    render(<ModelPane activeProjectId={null} />);
    const toggle = screen.getByRole('switch', { name: 'Native Resume for Codex' });
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to persist preference');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('hides Native Resume for replay-only runtimes and older backends', () => {
    agentStatus = { ...nativeResumeStatus(), capabilities: { nativeResume: false } };
    const { rerender } = render(<ModelPane activeProjectId={null} />);
    expect(screen.queryByRole('switch', { name: /Native Resume/ })).toBeNull();
    agentStatus = { ...nativeResumeStatus(), nativeResumeByRuntime: undefined };
    rerender(<ModelPane activeProjectId={null} />);
    expect(screen.queryByRole('switch', { name: /Native Resume/ })).toBeNull();
  });

  it('defaults an unset runtime preference to enabled', () => {
    agentStatus = { ...nativeResumeStatus(), nativeResumeByRuntime: {} };
    render(<ModelPane activeProjectId={null} />);
    expect(screen.getByRole('switch', { name: /Native Resume/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('renders for the active, available Kiro runtime and enables the preference', () => {
    agentStatus = {
      runtime: 'kiro',
      label: 'Kiro',
      capabilities: {
        modes: false, permissions: false, providerModels: false, reasoning: false,
        apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
      },
      availableRuntimes: [
        { id: 'kiro', label: 'Kiro', available: true },
        { id: 'codex', label: 'Codex', available: true },
      ],
      hasRequiredKey: true,
    };

    render(<ModelPane activeProjectId={null} />);

    const toggle = screen.getByRole('switch', { name: 'Generate Kiro titles in background' });
    expect(toggle.getAttribute('aria-checked')).toBe(String(DEFAULT_PREFS.enableKiroSidecarTitles));

    fireEvent.click(toggle);
    expect(setPref).toHaveBeenCalledExactlyOnceWith('enableKiroSidecarTitles', true);
  });

  it('does not render when a different runtime is selected, even if Kiro is available', () => {
    agentStatus = {
      runtime: 'codex',
      label: 'Codex',
      capabilities: {
        modes: false, permissions: false, providerModels: false, reasoning: false,
        apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
      },
      availableRuntimes: [
        { id: 'kiro', label: 'Kiro', available: true },
        { id: 'codex', label: 'Codex', available: true },
      ],
      hasRequiredKey: true,
    };

    render(<ModelPane activeProjectId={null} />);

    expect(screen.queryByRole('switch', { name: 'Generate Kiro titles in background' })).toBeNull();
    expect(screen.queryByText('▸ TITLES')).toBeNull();
  });

  it('does not render when Kiro is selected but unavailable', () => {
    agentStatus = {
      runtime: 'kiro',
      label: 'Kiro',
      capabilities: {
        modes: false, permissions: false, providerModels: false, reasoning: false,
        apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
      },
      availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: false }],
      hasRequiredKey: true,
    };

    render(<ModelPane activeProjectId={null} />);

    expect(screen.queryByRole('switch', { name: 'Generate Kiro titles in background' })).toBeNull();
    expect(screen.queryByText('▸ TITLES')).toBeNull();
  });

  it('configures the selected web-search provider without exposing its saved key', async () => {
    agentStatus = {
      runtime: 'pi',
      label: 'Pi',
      capabilities: {
        modes: false, permissions: false, providerModels: false, reasoning: false,
        apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
      },
      availableRuntimes: [],
      hasRequiredKey: true,
      webSearchProvider: 'jina',
      webSearchProviders: [
        {
          id: 'jina', label: 'Jina Search', keyLabel: 'Jina API key',
          keyUrl: 'https://jina.ai/reader/', description: 'LLM-ready web results.', hasKey: false,
        },
        {
          id: 'tavily', label: 'Tavily', keyLabel: 'Tavily API key',
          keyUrl: 'https://app.tavily.com/home', description: 'Agent-focused results.', hasKey: true,
        },
      ],
    };

    render(<ModelPane activeProjectId={null} />);

    const provider = screen.getByRole('combobox', { name: 'Web search provider' });
    expect((provider as HTMLSelectElement).value).toBe('jina');
    expect(screen.getByText('Jina Search (missing)')).toBeTruthy();

    fireEvent.change(provider, { target: { value: 'tavily' } });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledWith({ webSearchProvider: 'tavily' }));

    fireEvent.change(screen.getByLabelText('Jina Search API key'), {
      target: { value: 'jina-test-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(saveWebSearchKey).toHaveBeenCalledWith('jina', 'jina-test-key'));
    expect(refreshAgentStatus).toHaveBeenCalled();
  });
});
