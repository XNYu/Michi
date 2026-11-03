import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../../../../state/prefs';
import { ModelPane } from './ModelPane';

const setPref = vi.fn();
const setPermissionSettings = vi.fn();
const refreshAgentStatus = vi.fn();
const saveAgentOptions = vi.hoisted(() => vi.fn());
const listAgentModels = vi.hoisted(() => vi.fn());
const saveWebSearchKey = vi.hoisted(() => vi.fn());
const clearWebSearchKey = vi.hoisted(() => vi.fn());
const saveProviderKey = vi.hoisted(() => vi.fn());
const clearProviderKey = vi.hoisted(() => vi.fn());
const verifyProviderKey = vi.hoisted(() => vi.fn());
const confirmDialog = vi.hoisted(() => vi.fn());
let agentStatus: any = null;
let prefsOverride: Partial<typeof DEFAULT_PREFS> = {};

vi.mock('../../../../state/chatStore', () => ({
  useChatStore: () => ({ agentStatus, refreshAgentStatus }),
}));

vi.mock('../../../../services/api', () => ({
  saveAgentOptions,
  listAgentModels,
  saveWebSearchKey,
  clearWebSearchKey,
  saveProviderKey,
  clearProviderKey,
  verifyProviderKey,
}));

vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog }));

vi.mock('../../../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../../state/prefs')>('../../../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({ prefs: { ...actual.DEFAULT_PREFS, ...prefsOverride }, setPref, setPermissionSettings }),
  };
});

function keyProvider(overrides: Record<string, unknown> = {}) {
  return { id: 'google', label: 'Google AI', keyLabel: 'Gemini API key', envVars: [], defaultModel: 'gemini-4-argon',
    keyUrl: 'https://aistudio.google.com/apikey', supportsReasoning: true, hasKey: true, ...overrides };
}

function keyStatus(provider = keyProvider()) {
  return { runtime: 'pi', label: 'Pi', provider: provider.id, model: 'gemini-4-argon', providers: [provider], hasRequiredKey: true,
    availableRuntimes: [], capabilities: { apiKeys: true } };
}

describe('ModelPane Kiro sidecar title setting', () => {
  beforeEach(() => {
    setPref.mockClear();
    setPermissionSettings.mockReset().mockResolvedValue(undefined);
    refreshAgentStatus.mockClear();
    saveAgentOptions.mockReset().mockResolvedValue({ ok: true });
    saveWebSearchKey.mockReset().mockResolvedValue({ ok: true });
    clearWebSearchKey.mockReset().mockResolvedValue({ ok: true });
    saveProviderKey.mockReset().mockResolvedValue({ ok: true });
    clearProviderKey.mockReset().mockResolvedValue({ ok: true });
    verifyProviderKey.mockReset().mockResolvedValue({ ok: true, model: 'gemini-4-argon', latencyMs: 142 });
    confirmDialog.mockReset().mockResolvedValue(true);
    agentStatus = null;
    prefsOverride = {};
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
  it('shows Workflows only for the selected runtime and preserves its saved preference', async () => {
    agentStatus = { runtime: 'claude', label: 'Claude', capabilities: {}, hasRequiredKey: true,
      availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }, { id: 'claude', label: 'Claude', available: true }],
      workflowRuntimes: ['kiro'], workflowsByRuntime: { kiro: true } };
    const view = render(<ModelPane activeProjectId={null} />);
    expect(screen.queryByRole('switch', { name: /Workflows/ })).toBeNull();
    agentStatus = { ...agentStatus, runtime: 'kiro', label: 'Kiro' };
    view.rerender(<ModelPane activeProjectId={null} />);
    const workflows = screen.getByRole('switch', { name: 'Workflows for Kiro' });
    expect(workflows.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(workflows);
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ workflowsByRuntime: { kiro: false } }));
    agentStatus = { ...agentStatus, runtime: 'codex', label: 'Codex' };
    view.rerender(<ModelPane activeProjectId={null} />);
    expect(screen.queryByRole('switch', { name: /Workflows/ })).toBeNull();
  });

  it('hides unavailable choices and allows recovery when only one other runtime is available', async () => {
    agentStatus = { runtime: 'claude', label: 'Claude', capabilities: {}, hasRequiredKey: true,
      availableRuntimes: [{ id: 'crew', label: 'Kiro Crew', available: false }, { id: 'kiro', label: 'Kiro', available: true }] };
    render(<ModelPane activeProjectId={null} />);
    const picker = screen.getByRole('combobox', { name: 'Runtime' });
    expect(within(picker).queryByRole('option', { name: /Kiro Crew/ })).toBeNull();
    expect((picker as HTMLSelectElement).value).toBe('');
    fireEvent.change(picker, { target: { value: 'kiro' } });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ runtime: 'kiro' }));
  });

  it('saves model and effort for the runtime Settings shows', async () => {
    agentStatus = { runtime: 'kiro', label: 'Kiro', model: 'opus-5.5', reasoning: 'low', hasRequiredKey: true,
      availableRuntimes: [], capabilities: { models: true, reasoning: true, supportedReasoningLevels: ['low', 'high'] } };
    listAgentModels.mockResolvedValue({ models: [{ id: 'opus-5.5', label: 'Opus 5.5' }, { id: 'sonnet-5.5', label: 'Sonnet 5.5' }], sanitizedModel: null });
    render(<ModelPane activeProjectId={null} />);
    const model = screen.getByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(model.textContent).toContain('Opus 5.5'));
    fireEvent.click(model);
    // A short catalog is a plain list: no filter field.
    expect(screen.queryByRole('searchbox', { name: 'Filter models' })).toBeNull();
    const list = screen.getByRole('listbox', { name: 'Models' });
    expect(within(list).getByRole('option', { name: /Opus 5\.5/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(list).getByRole('option', { name: /Sonnet 5\.5/ }));
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ model: 'sonnet-5.5', expectedRuntime: 'kiro' }));
    expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull();
    fireEvent.change(screen.getByDisplayValue('low'), { target: { value: 'high' } });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenLastCalledWith({ reasoning: 'high', expectedRuntime: 'kiro' }));
  });

  it('filters the Pi catalog inside the model list and picks with the keyboard', async () => {
    agentStatus = { runtime: 'pi', label: 'Pi', provider: 'openrouter', model: 'stealth/ox-alpha', hasRequiredKey: true,
      providers: [keyProvider({ id: 'openrouter', label: 'OpenRouter', requiresUserKey: false })],
      availableRuntimes: [], capabilities: { models: true, providerModels: true } };
    listAgentModels.mockResolvedValue({ sanitizedModel: null, models: [
      { id: 'stealth/ox-alpha', label: 'Ox Alpha' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro' },
    ] });
    render(<ModelPane activeProjectId={null} />);
    const model = screen.getByRole('combobox', { name: 'Model' });
    await waitFor(() => expect(model.textContent).toContain('Ox Alpha'));
    // One control: the filter lives in the list, not above it.
    expect(screen.queryByRole('searchbox', { name: 'Filter models' })).toBeNull();
    fireEvent.click(model);
    expect(model.getAttribute('aria-expanded')).toBe('true');
    const filter = screen.getByRole('searchbox', { name: 'Filter models' });
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: 'gemini' } });
    const list = screen.getByRole('listbox', { name: 'Models' });
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual([expect.stringContaining('Gemini 3 Pro')]);
    expect(screen.getByRole('status').textContent).toBe('1 of 3 models');
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ model: 'google/gemini-3-pro', expectedRuntime: 'pi' }));
    expect(document.activeElement).toBe(model);

    fireEvent.click(model);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter models' }), { target: { value: 'nothing' } });
    expect(screen.getByRole('status').textContent).toBe('No models match “nothing”.');
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Filter models' }), { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull();
    expect(document.activeElement).toBe(model);
    expect(saveAgentOptions).toHaveBeenCalledTimes(1);
  });

  it('shows a saved key as a status beside Verify, Replace and Clear, and asks for a key only when replacing', async () => {
    agentStatus = keyStatus();
    render(<ModelPane activeProjectId={null} />);
    expect(screen.getByText('Key saved')).toBeTruthy();
    expect(screen.queryByLabelText('Google AI API key')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Google AI key console' }).getAttribute('href')).toBe('https://aistudio.google.com/apikey');

    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(verifyProviderKey).toHaveBeenCalledExactlyOnceWith('google', { key: undefined, model: 'gemini-4-argon' }));
    expect((await screen.findByText(/^Verified Google AI/)).textContent).toBe('Verified Google AI / gemini-4-argon in 142ms.');

    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    const input = screen.getByLabelText('Google AI API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('button', { name: 'Replace…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Google AI API key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    fireEvent.change(screen.getByLabelText('Google AI API key'), { target: { value: 'new-key' } });
    fireEvent.keyDown(screen.getByLabelText('Google AI API key'), { key: 'Enter' });
    await waitFor(() => expect(saveProviderKey).toHaveBeenCalledExactlyOnceWith('google', 'new-key'));
    await waitFor(() => expect(screen.queryByLabelText('Google AI API key')).toBeNull());
    expect(refreshAgentStatus).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(clearProviderKey).toHaveBeenCalledExactlyOnceWith('google'));
    expect(confirmDialog).toHaveBeenCalledOnce();
  });

  it('asks for the key when none is saved', async () => {
    agentStatus = keyStatus(keyProvider({ hasKey: false }));
    render(<ModelPane activeProjectId={null} />);
    expect(screen.getByText('Key required')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Replace…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Google AI API key'), { target: { value: 'first-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(verifyProviderKey).toHaveBeenCalledExactlyOnceWith('google', { key: 'first-key', model: 'gemini-4-argon' }));
    fireEvent.click(save);
    await waitFor(() => expect(saveProviderKey).toHaveBeenCalledExactlyOnceWith('google', 'first-key'));
  });

  it('sets the global permission mode in its own row, offering the modes its runtimes support', async () => {
    prefsOverride = { globalPermissions: true, permissionMode: 'yolo' };
    agentStatus = { runtime: 'kiro', label: 'Kiro', capabilities: {}, hasRequiredKey: true,
      availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }] };
    const view = render(<ModelPane activeProjectId={null} />);
    const mode = screen.getByRole('combobox', { name: 'Permission mode' }) as HTMLSelectElement;
    // Kiro has no YOLO; a saved YOLO shows (and runs) as Trust.
    expect(mode.value).toBe('trust');
    expect(within(mode).getAllByRole('option').map((option) => option.textContent)).toEqual(['Ask', 'Trust']);
    expect(screen.queryByRole('button', { name: /^Permissions:/ })).toBeNull();
    fireEvent.change(mode, { target: { value: 'ask' } });
    await waitFor(() => expect(setPermissionSettings).toHaveBeenCalledExactlyOnceWith({ global: true, mode: 'ask' }));

    agentStatus = { ...agentStatus, availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true, approveForMe: true }, { id: 'claude', label: 'Claude', available: true }] };
    view.rerender(<ModelPane activeProjectId={null} />);
    expect(within(screen.getByRole('combobox', { name: 'Permission mode' })).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Ask', 'Approve for me', 'Trust', 'YOLO']);

    prefsOverride = { globalPermissions: false };
    view.rerender(<ModelPane activeProjectId={null} />);
    expect(screen.queryByRole('combobox', { name: 'Permission mode' })).toBeNull();
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
