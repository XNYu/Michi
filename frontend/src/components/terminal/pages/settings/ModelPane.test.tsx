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

  it('renders disabled by default and enables the preference from Settings', () => {
    render(<ModelPane activeProjectId={null} />);

    const toggle = screen.getByRole('switch', { name: 'Generate Kiro titles in background' });
    expect(toggle.getAttribute('aria-checked')).toBe(String(DEFAULT_PREFS.enableKiroSidecarTitles));

    fireEvent.click(toggle);
    expect(setPref).toHaveBeenCalledExactlyOnceWith('enableKiroSidecarTitles', true);
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

  it('does not render web-search settings when the backend does not advertise the Railway feature', () => {
    agentStatus = {
      runtime: 'pi',
      label: 'Pi',
      capabilities: {
        modes: false, permissions: false, providerModels: false, reasoning: false,
        apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false,
      },
      availableRuntimes: [],
      hasRequiredKey: true,
    };

    render(<ModelPane activeProjectId={null} />);

    expect(screen.queryByRole('combobox', { name: 'Web search provider' })).toBeNull();
    expect(screen.queryByText('▸ WEB SEARCH')).toBeNull();
  });
});
