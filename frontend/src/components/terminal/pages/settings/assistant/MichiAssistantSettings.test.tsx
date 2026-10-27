import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentCapabilities, AgentModelInfo } from '../../../../../services/api/agentRuntime';
import { AssistantApiError, MICHI_ASSISTANT_RESET_EVENT, type AssistantInfo } from '../../../../../services/api/assistant';
import { MichiAssistantSettings } from './MichiAssistantSettings';
import { resetAssistantProbe } from './assistantProbe';

const api = vi.hoisted(() => ({
  fetchAssistant: vi.fn(),
  updateAssistantSettings: vi.fn(),
  resetAssistant: vi.fn(),
  fetchAgentStatus: vi.fn(),
}));
const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
const catalog = vi.hoisted(() => ({
  value: {
    models: [] as AgentModelInfo[],
    providers: [],
    capabilities: null as AgentCapabilities | null,
    loading: false,
    waiting: false,
    error: null as string | null,
    retry: vi.fn(),
  },
  calls: [] as Array<{ runtime?: string | null; connectionId?: string }>,
}));

vi.mock('../../../../../services/api/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../services/api/assistant')>()),
  ...api,
}));
vi.mock('../../../../../services/api/agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../services/api/agentRuntime')>()),
  fetchAgentStatus: api.fetchAgentStatus,
}));
vi.mock('../../../../../hooks/useRuntimeCatalog', () => ({
  useRuntimeCatalog: (opts: { runtime?: string | null }) => {
    catalog.calls.push(opts);
    return catalog.value;
  },
}));
const AGENT_STATUS = {
  runtime: 'claude',
  availableRuntimes: [
    { id: 'claude', label: 'Claude Code', available: true },
    { id: 'kiro', label: 'Kiro CLI', available: true },
    { id: 'codex', label: 'Codex', available: false },
  ],
};
vi.mock('../../../../../state/chatStore', () => ({ useChatStore: () => ({ agentStatus: AGENT_STATUS }) }));
vi.mock('../../../../ui/ConfirmDialog', () => confirm);

const CAPS: AgentCapabilities = {
  modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], apiKeys: false, warmSessions: false,
  saveContext: false, spawnBranches: false, nativeResume: false,
};
const MODELS: AgentModelInfo[] = [
  { id: 'opus', label: 'Opus 5.5', supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'] },
  { id: 'haiku', label: 'Haiku', supportsReasoning: false },
];

function info(settings: Partial<AssistantInfo['settings']> = {}): AssistantInfo {
  return {
    nodeId: 'n1', workspaceId: 'w1', treeId: 't1',
    settings: { runtimeId: 'claude', modelId: 'opus', reasoning: 'high', ...settings },
    supportedRuntimes: ['claude', 'kiro', 'codex'],
  };
}

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

async function mount() {
  render(<MichiAssistantSettings />);
  await flush();
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  confirm.confirmDialog.mockReset();
  catalog.calls = [];
  resetAssistantProbe();
  catalog.value = { ...catalog.value, models: MODELS, capabilities: CAPS, loading: false, error: null, retry: vi.fn() };
  api.fetchAssistant.mockResolvedValue(info());
  api.fetchAgentStatus.mockResolvedValue(AGENT_STATUS);
});
afterEach(cleanup);

describe('MichiAssistantSettings', () => {
  it('is hidden when the backend has no assistant', async () => {
    api.fetchAssistant.mockRejectedValue(new AssistantApiError(404, 'Not found'));
    const { container } = render(<MichiAssistantSettings />);
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('is hidden when the backend answers something that is not an assistant', async () => {
    api.fetchAssistant.mockRejectedValue(new AssistantApiError(200, 'Unexpected assistant response', true));
    const { container } = render(<MichiAssistantSettings />);
    await flush();
    expect(container.innerHTML).toBe('');
  });

  it('says so when the assistant cannot be read', async () => {
    api.fetchAssistant.mockRejectedValue(new AssistantApiError(500, 'boom'));
    await mount();
    expect(within(screen.getByRole('region', { name: 'Assistant' })).getByRole('alert').textContent).toMatch(/Couldn.t load/);
  });

  it('shows the runtime, the model and only the levels that model supports', async () => {
    await mount();
    const runtime = screen.getByRole('combobox', { name: 'Assistant runtime' }) as HTMLSelectElement;
    expect(runtime.value).toBe('claude');
    expect([...runtime.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ['Claude Code', false], ['Kiro CLI', false], ['Codex (unavailable)', true],
    ]);
    expect(screen.getByText('Applies to new conversations; the current one keeps its settings')).toBeTruthy();
    expect(catalog.calls.at(-1)?.runtime).toBe('claude');
    expect(catalog.calls.at(-1)?.connectionId).toBe('local');

    const model = screen.getByRole('combobox', { name: 'Assistant model' }) as HTMLSelectElement;
    expect(model.value).toBe('opus');
    expect([...model.options].map((o) => o.textContent)).toEqual(['Default', 'Opus 5.5', 'Haiku']);

    const levels = within(screen.getByRole('group', { name: 'Reasoning' })).getAllByRole('button');
    expect(levels.map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Default', 'false'], ['Low', 'false'], ['Medium', 'false'], ['High', 'true'],
    ]);
    // A narrow drawer puts the levels under "Reasoning" rather than breaking the word.
    expect(screen.getByRole('group', { name: 'Reasoning' }).closest('.michi-set__row')!.classList.contains('michi-set__row--wrap')).toBe(true);
    expect(within(screen.getByRole('region', { name: 'Assistant' })).getByText('Assistant')).toBeTruthy();
    const widgets = screen.getByRole('switch', { name: 'Sandboxed widgets' }) as HTMLButtonElement;
    expect(widgets.getAttribute('aria-checked')).toBe('false');
    expect(widgets.disabled).toBe(true);
    expect(screen.getByText('Coming later')).toBeTruthy();
  });

  it('uses local runtime availability even when the active workspace Backend differs', async () => {
    api.fetchAgentStatus.mockResolvedValue({
      ...AGENT_STATUS,
      availableRuntimes: AGENT_STATUS.availableRuntimes.map((runtime) => runtime.id === 'codex' ? { ...runtime, label: 'Local Codex', available: true } : runtime),
    });
    await mount();
    expect(api.fetchAgentStatus).toHaveBeenCalledWith('local', expect.any(AbortSignal));
    const option = screen.getByRole('option', { name: 'Local Codex' }) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
  });

  it('presses Default when no level is set, and saves Default as null', async () => {
    api.updateAssistantSettings.mockImplementation(async (patch) => info(patch));
    await mount();
    const group = () => within(screen.getByRole('group', { name: 'Reasoning' }));
    fireEvent.click(group().getByRole('button', { name: 'Default' }));
    await flush();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith({ reasoning: null });
    expect(group().getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('true');
    expect(group().getByRole('button', { name: 'High' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('drops a reasoning level the newly picked model does not offer', async () => {
    catalog.value = { ...catalog.value, models: [...MODELS, { id: 'sonnet', label: 'Sonnet', supportsReasoning: true, supportedReasoningLevels: ['low', 'medium'] }] };
    api.updateAssistantSettings.mockImplementation(async (patch) => info(patch));
    await mount();
    const model = screen.getByRole('combobox', { name: 'Assistant model' });
    fireEvent.change(model, { target: { value: 'sonnet' } });
    await flush();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith({ modelId: 'sonnet', reasoning: null });
  });

  it('hides Reasoning when the model has no levels to pick from', async () => {
    api.fetchAssistant.mockResolvedValue(info({ modelId: 'haiku', reasoning: null }));
    await mount();
    expect(screen.queryByRole('group', { name: 'Reasoning' })).toBeNull();
  });

  it('switches runtime from that runtime’s defaults and shows what the backend answers', async () => {
    api.updateAssistantSettings.mockResolvedValue(info({ runtimeId: 'kiro', modelId: null, reasoning: null }));
    await mount();
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant runtime' }), { target: { value: 'kiro' } });
    await flush();
    expect(api.updateAssistantSettings).toHaveBeenCalledWith({ runtimeId: 'kiro', modelId: null, reasoning: null });
    expect((screen.getByRole('combobox', { name: 'Assistant runtime' }) as HTMLSelectElement).value).toBe('kiro');
    expect(catalog.calls.at(-1)?.runtime).toBe('kiro');
  });

  it('saves a model, Default as null, and a reasoning level', async () => {
    api.updateAssistantSettings.mockImplementation(async (patch) => info(patch));
    await mount();
    const model = screen.getByRole('combobox', { name: 'Assistant model' });
    fireEvent.change(model, { target: { value: '' } });
    await flush();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith({ modelId: null });
    fireEvent.change(model, { target: { value: 'opus' } });
    await flush();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith({ modelId: 'opus' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Reasoning' })).getByRole('button', { name: 'Low' }));
    await flush();
    expect(api.updateAssistantSettings).toHaveBeenLastCalledWith({ reasoning: 'low' });
  });

  it('says when a save fails and keeps the old settings', async () => {
    api.updateAssistantSettings.mockRejectedValue(new Error('nope'));
    await mount();
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant runtime' }), { target: { value: 'kiro' } });
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn.t save/);
    expect((screen.getByRole('combobox', { name: 'Assistant runtime' }) as HTMLSelectElement).value).toBe('claude');
  });

  it('re-checks the model list', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(catalog.value.retry).toHaveBeenCalledTimes(1);
  });

  it('starts a new conversation only after the user confirms', async () => {
    api.resetAssistant.mockResolvedValue(info({ reasoning: null }));
    confirm.confirmDialog.mockResolvedValueOnce(false);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Start new' }));
    await flush();
    expect(api.resetAssistant).not.toHaveBeenCalled();

    confirm.confirmDialog.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'Start new' }));
    await flush();
    expect(api.resetAssistant).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe('Started a new conversation');
  });

  it('tells the ⌘J panel about the new conversation, and only when the reset worked', async () => {
    const fresh = { ...info({ reasoning: null }), nodeId: 'n2' };
    const heard: unknown[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent).detail);
    window.addEventListener(MICHI_ASSISTANT_RESET_EVENT, listener);
    try {
      confirm.confirmDialog.mockResolvedValue(true);
      api.resetAssistant.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(fresh);
      await mount();
      fireEvent.click(screen.getByRole('button', { name: 'Start new' }));
      await flush();
      expect(heard).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Start new' }));
      await flush();
      expect(heard).toEqual([fresh]);
    } finally {
      window.removeEventListener(MICHI_ASSISTANT_RESET_EVENT, listener);
    }
  });
});
