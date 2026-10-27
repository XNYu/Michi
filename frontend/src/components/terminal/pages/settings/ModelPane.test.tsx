import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../../../../state/prefs';
import { ModelPane } from './ModelPane';

const setPref = vi.fn();
const refreshAgentStatus = vi.fn();
const saveAgentOptions = vi.hoisted(() => vi.fn());
const listAgentModels = vi.hoisted(() => vi.fn());
const saveWebSearchKey = vi.hoisted(() => vi.fn());
const clearWebSearchKey = vi.hoisted(() => vi.fn());
let agentStatus: any = null;

vi.mock('../../../../state/chatStore', () => ({
  useChatStore: () => ({ agentStatus, refreshAgentStatus }),
}));

vi.mock('../../../../services/api', () => ({
  saveAgentOptions,
  listAgentModels,
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
      capabilityDescriptor: { sessionFork: { availability: 'native' } },
      nativeResumeByRuntime: { codex: true, claude: false },
      nativeForkByRuntime: { codex: true, claude: false } };
  }

  // Model, provider and effort ids belong to the runtime Settings shows; the
  // backend rejects a save if its active runtime has changed since.
  it('saves model and effort for the runtime Settings shows', async () => {
    agentStatus = { runtime: 'kiro', label: 'Kiro', model: 'opus-5.5', reasoning: 'low', hasRequiredKey: true,
      availableRuntimes: [], capabilities: { models: true, reasoning: true, supportedReasoningLevels: ['low', 'high'] } };
    listAgentModels.mockResolvedValue({ models: [{ id: 'opus-5.5', label: 'Opus 5.5' }, { id: 'sonnet-5.5', label: 'Sonnet 5.5' }], sanitizedModel: null });
    render(<ModelPane activeProjectId={null} />);
    fireEvent.change(await screen.findByDisplayValue('Opus 5.5'), { target: { value: 'sonnet-5.5' } });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ model: 'sonnet-5.5', expectedRuntime: 'kiro' }));
    fireEvent.change(screen.getByDisplayValue('low'), { target: { value: 'high' } });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenLastCalledWith({ reasoning: 'high', expectedRuntime: 'kiro' }));
  });

  it('switches provider for the runtime Settings shows', async () => {
    const provider = (id: string) => ({ id, label: id.toUpperCase(), keyLabel: '', envVars: [], defaultModel: `${id}-default`, supportsReasoning: false, hasKey: true });
    agentStatus = { runtime: 'pi', label: 'Pi', provider: 'p1', providers: [provider('p1'), provider('p2')], hasRequiredKey: true,
      availableRuntimes: [], capabilities: { providerModels: true } };
    render(<ModelPane activeProjectId={null} />);
    fireEvent.change(screen.getByDisplayValue(/^P1/), { target: { value: 'p2' } });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ provider: 'p2', model: 'p2-default', expectedRuntime: 'pi' }));
  });

  it('keeps the Native Fork preference on failure and supports retry', async () => {
    agentStatus = nativeResumeStatus();
    saveAgentOptions.mockResolvedValueOnce({ ok: false, error: 'Unable to persist fork preference' });
    render(<ModelPane activeProjectId={null} />);
    const fork = screen.getByRole('switch', { name: 'Native Fork for Codex' });
    fireEvent.click(fork);
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to persist fork preference');
    expect(fork.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(fork);
    await waitFor(() => expect(fork.getAttribute('aria-checked')).toBe('false'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says that crossing YOLO restarts Claude chats and stops their workflows, only when Claude is available', () => {
    const status = (runtime: string) => ({
      runtime, label: runtime,
      capabilities: { modes: false, permissions: false, providerModels: false, reasoning: false, apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false },
      availableRuntimes: [], hasRequiredKey: true,
    });
    agentStatus = status('claude');
    const { rerender } = render(<ModelPane activeProjectId={null} />);
    expect(screen.getByText(/restarts it on its next message, which stops any workflow it is running/)).toBeTruthy();
    agentStatus = status('codex');
    rerender(<ModelPane activeProjectId={null} />);
    expect(screen.queryByText(/stops any workflow it is running/)).toBeNull();
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
