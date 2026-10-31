import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { MetaAgentGuardStatus } from 'michi-shared';
import type { MetaAgentInfo } from '../../../../services/api/metaAgent';
import type { AgentCapabilities, AgentModelInfo } from '../../../../services/api/agentRuntime';
import { MetaAgentApiError } from '../../../../services/api/metaAgent';
import { resetMetaAgentStore } from '../../../../state/metaAgent/useMetaAgent';
import { resetMetaAgentOverviewStore } from '../../scheduled/metaAgent/useMetaAgentOverview';
import { MetaAgentSettings } from './MetaAgentSettings';

const api = vi.hoisted(() => ({
  decideMetaAgentToolApproval: vi.fn(),
  fetchMetaAgent: vi.fn(),
  updateMetaAgentSettings: vi.fn(),
  retryMetaAgentGuard: vi.fn(),
  fetchAgentStatus: vi.fn(),
  fetchOverview: vi.fn(),
  setPaused: vi.fn(),
}));
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

vi.mock('../../../../services/api/metaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/metaAgent')>()),
  decideMetaAgentToolApproval: api.decideMetaAgentToolApproval,
  fetchMetaAgent: api.fetchMetaAgent,
  updateMetaAgentSettings: api.updateMetaAgentSettings,
  retryMetaAgentGuard: api.retryMetaAgentGuard,
}));
vi.mock('../../../../services/api/agentRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/agentRuntime')>()),
  fetchAgentStatus: api.fetchAgentStatus,
}));
vi.mock('../../../../services/api/metaAgentOverview', () => ({
  fetchMetaAgentOverview: api.fetchOverview,
  setMetaAgentPaused: api.setPaused,
}));
vi.mock('../../../../hooks/useRuntimeCatalog', () => ({
  useRuntimeCatalog: (opts: { runtime?: string | null }) => {
    catalog.calls.push(opts);
    return catalog.value;
  },
}));

const CAPS: AgentCapabilities = {
  modes: true, permissions: true, models: true, providerModels: false, reasoning: true,
  supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: false,
  saveContext: false, spawnBranches: false, nativeResume: false,
};
const MODELS: AgentModelInfo[] = [
  { id: 'gpt-5.5-codex', label: 'GPT 5.5 Codex', supportsReasoning: true, supportedReasoningLevels: ['low', 'medium', 'high'] },
  { id: 'gpt-mini', label: 'GPT mini', supportsReasoning: false },
];
const AGENT_STATUS = {
  runtime: 'claude', model: 'claude-opus-5.5', reasoning: 'high',
  availableRuntimes: ['claude', 'pi', 'codex', 'kiro', 'crew'].map((id) => ({ id, label: id, available: true })),
};

const FOLLOW: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high', followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const CUSTOM_CODEX: MetaAgentInfo = {
  settings: { runtimeId: 'codex', providerId: null, modelId: 'gpt-5.5-codex', reasoning: 'high' },
  resolved: { runtimeId: 'codex', providerId: null, modelId: 'gpt-5.5-codex', reasoning: 'high', followsGlobal: false },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const followOn = (runtimeId: string, modelId: string | null = null): MetaAgentInfo => ({
  ...FOLLOW, resolved: { runtimeId, providerId: null, modelId, reasoning: null, followsGlobal: true },
});
const failed = (overrides: Partial<MetaAgentGuardStatus> = {}): MetaAgentGuardStatus => ({
  state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['execute_bash', 'fs_write'],
  detail: 'Kiro published 2 tools outside the allow-list', checkedAt: Date.UTC(2026, 9, 23, 9, 41), ...overrides,
});

const overview = (state: 'running' | 'paused' | 'error') => ({
  state, runtime: FOLLOW.resolved, today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
  cursors: [], recentRuns: [],
});

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function mount(info: MetaAgentInfo | Error = FOLLOW) {
  if (info instanceof Error) api.fetchMetaAgent.mockRejectedValue(info);
  else api.fetchMetaAgent.mockResolvedValue(info);
  render(<MetaAgentSettings />);
  await flush();
}

const runtimeSection = () => screen.getByRole('region', { name: 'Runtime' });
const lastPatch = () => api.updateMetaAgentSettings.mock.calls.at(-1)?.[0];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  resetMetaAgentStore();
  resetMetaAgentOverviewStore();
  api.fetchOverview.mockResolvedValue(overview('running'));
  catalog.calls = [];
  catalog.value = { ...catalog.value, models: MODELS, capabilities: CAPS, loading: false, error: null, retry: vi.fn() };
  api.fetchAgentStatus.mockResolvedValue(AGENT_STATUS);
});
afterEach(() => cleanup());

describe('Settings › Meta agent runtime', () => {
  it('follows the global settings by default and says what it runs on now', async () => {
    await mount();
    const section = runtimeSection();
    expect(within(section).getByRole('radio', { name: /Follow global settings/ })).toHaveProperty('checked', true);
    expect(within(section).getByRole('radio', { name: /Custom/ })).toHaveProperty('checked', false);
    expect(section.textContent).toContain('Now Claude · claude-opus-5.5 · reasoning high. Change the global settings and the Meta agent follows from its next run.');
    expect(within(section).queryByRole('group', { name: 'Meta agent runtime' })).toBeNull();
  });

  it('pins what it runs on now when Custom is chosen, then lists the supported available runtimes', async () => {
    await mount();
    api.updateMetaAgentSettings.mockResolvedValue({
      ...FOLLOW, settings: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high' },
      resolved: { ...FOLLOW.resolved, followsGlobal: false },
    });
    fireEvent.click(screen.getByRole('radio', { name: /Custom/ }));
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high' });
    const chips = within(screen.getByRole('group', { name: 'Meta agent runtime' })).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Claude', 'Pi', 'Codex', 'Kiro']);
    expect(chips.map((chip) => (chip as HTMLButtonElement).disabled)).toEqual([false, false, false, false]);
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('switches the custom runtime with the new runtime’s defaults', async () => {
    await mount(CUSTOM_CODEX);
    api.updateMetaAgentSettings.mockResolvedValue({
      ...CUSTOM_CODEX, settings: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null },
      resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kiro' }));
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null });
    expect(screen.getByRole('button', { name: 'Kiro' }).getAttribute('aria-pressed')).toBe('true');
    expect(runtimeSection().textContent).toContain('Now using Kiro · default model (custom). Background maintenance: Michi checks tool access; external tools are read-only.');
  });

  it('says what each “Default” stands for, and the line the window’s chip repeats', async () => {
    await mount({
      ...CUSTOM_CODEX,
      settings: { runtimeId: 'codex', providerId: null, modelId: null, reasoning: null },
      resolved: { runtimeId: 'codex', providerId: null, modelId: 'gpt-5.5-codex', reasoning: 'high', followsGlobal: false },
    });
    const first = (name: string) => (screen.getByRole('combobox', { name }) as HTMLSelectElement).options[0]!.textContent;
    expect(first('Meta agent model')).toBe('Default (GPT 5.5 Codex)');
    expect(first('Meta agent reasoning')).toBe('Default (High)');
    expect(runtimeSection().textContent).toContain('Now using Codex · gpt-5.5-codex · reasoning high (custom)');
    cleanup();

    // A value picked by hand needs no explanation.
    await mount(CUSTOM_CODEX);
    expect(first('Meta agent model')).toBe('Default');
    expect(first('Meta agent reasoning')).toBe('Default');
  });

  it('explains when the runtime it follows cannot run it, and switches to the first runtime that can', async () => {
    const reason = 'The Meta agent does not run on Kiro Crew yet. Choose another runtime for it in Settings › Meta agent.';
    await mount({ ...followOn('crew'), availability: { available: false, reason } });
    const notice = within(runtimeSection()).getByRole('status');
    expect(notice.textContent).toContain(reason);
    expect(runtimeSection().textContent).toContain('Crew: the Meta agent can’t use Kiro Crew yet.');
    expect(runtimeSection().textContent).not.toContain('Now using Crew');
    api.updateMetaAgentSettings.mockResolvedValue({
      ...CUSTOM_CODEX, settings: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null },
      resolved: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: false },
    });
    fireEvent.click(within(notice).getByRole('button', { name: 'Use a custom runtime' }));
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: 'claude', providerId: null, modelId: null, reasoning: null });
    expect(within(runtimeSection()).queryByRole('status')).toBeNull();
  });

  it('hides unavailable runtime choices while retaining diagnostics for an unavailable saved selection', async () => {
    api.fetchAgentStatus.mockResolvedValue({
      ...AGENT_STATUS,
      availableRuntimes: AGENT_STATUS.availableRuntimes.map((runtime) => runtime.id === 'claude'
        ? { ...runtime, available: false, unavailableReason: 'claude binary not found. Install with: npm install -g @anthropic-ai/claude-code.' }
        : runtime.id === 'kiro' ? { ...runtime, available: false, unavailableReason: 'kiro-cli not found' } : runtime),
    });
    await mount({ ...CUSTOM_CODEX, settings: { ...CUSTOM_CODEX.settings, runtimeId: 'claude' } });
    const choices = screen.getByRole('group', { name: 'Meta agent runtime' });
    expect(within(choices).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['Pi', 'Codex']);
    expect(screen.getByText('Claude isn’t installed on this computer.')).toBeTruthy();
    expect(screen.queryByText('Kiro isn’t installed on this computer.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How to install' }));
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code', { selector: 'code' })).toBeTruthy();
  });

  it('sends nulls for every field when going back to the global settings', async () => {
    await mount(CUSTOM_CODEX);
    api.updateMetaAgentSettings.mockResolvedValue(FOLLOW);
    // In Custom mode the follow-global row still describes the global settings.
    expect(runtimeSection().textContent).toContain('Now Claude · claude-opus-5.5 · reasoning high.');
    fireEvent.click(screen.getByRole('radio', { name: /Follow global settings/ }));
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: null, providerId: null, modelId: null, reasoning: null });
    expect(screen.getByRole('radio', { name: /Follow global settings/ })).toHaveProperty('checked', true);
  });

  it('saves the custom model and reasoning through the runtime catalog', async () => {
    await mount(CUSTOM_CODEX);
    expect(catalog.calls.at(-1)).toMatchObject({ runtime: 'codex', connectionId: 'local' });
    api.updateMetaAgentSettings.mockResolvedValue(CUSTOM_CODEX);
    fireEvent.change(screen.getByRole('combobox', { name: 'Meta agent model' }), { target: { value: '' } });
    await flush();
    expect(lastPatch()).toEqual({ modelId: null });
    fireEvent.change(screen.getByRole('combobox', { name: 'Meta agent reasoning' }), { target: { value: 'low' } });
    await flush();
    expect(lastPatch()).toEqual({ reasoning: 'low' });
    // A model without reasoning drops the explicit level.
    fireEvent.change(screen.getByRole('combobox', { name: 'Meta agent model' }), { target: { value: 'gpt-mini' } });
    await flush();
    expect(lastPatch()).toEqual({ modelId: 'gpt-mini', reasoning: null });
  });

  it('shows a save failure and keeps the stored choice', async () => {
    await mount();
    api.updateMetaAgentSettings.mockRejectedValue(new MetaAgentApiError(400, 'Unknown runtime'));
    fireEvent.click(screen.getByRole('radio', { name: /Custom/ }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Unknown runtime');
    expect(screen.getByRole('radio', { name: /Follow global settings/ })).toHaveProperty('checked', true);
  });
});

describe('Settings › Meta agent restriction', () => {
  it.each([
    ['claude', 'Now using Claude · default model (follows global). Background maintenance: Michi checks tool access; external tools are read-only.'],
    ['pi', 'Now using Pi · default model (follows global). Background maintenance: Michi checks tool access; external tools are read-only.'],
    ['codex', 'Now using Codex · default model (follows global). Background maintenance: Michi checks tool access; external tools are read-only.'],
    ['kiro', 'Now using Kiro · default model (follows global). Background maintenance: Michi checks tool access; external tools are read-only.'],
  ])('describes how %s is restricted', async (runtimeId, text) => {
    await mount(followOn(runtimeId));
    const section = runtimeSection();
    expect(section.textContent).toContain(text);
    expect(section.textContent).toContain('Background maintenance can change Michi content and use external read-only tools. Other external tools need your saved approval. Assistant chat runs on the global settings, or what you pick in its composer, with that AI service’s built-in and connected tools and ordinary chat permissions.');
  });

  it('names the resolved runtime in the follow-global line', async () => {
    await mount(followOn('kiro', 'kiro_default'));
    expect(runtimeSection().textContent).toContain('Now Kiro · kiro_default. Change the global settings');
  });
});

describe('Settings › Meta agent guard failure', () => {
  it('shows a red box with the extra tools, and Retry clears the failed check', async () => {
    await mount({ ...followOn('kiro'), guard: { maintenance: failed(), chat: null } });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Meta agent stopped: Kiro started with extra tools');
    expect(within(alert).getAllByText(/^(execute_bash|fs_write)$/).map((node) => node.tagName)).toEqual(['CODE', 'CODE']);

    api.retryMetaAgentGuard.mockResolvedValue(followOn('kiro'));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await flush();
    expect(api.retryMetaAgentGuard).toHaveBeenCalledWith('maintenance');
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Meta agent stopped/)).toBeNull();
  });

  it('retries both checks when both failed, and keeps the box when the retry fails', async () => {
    const both = { ...followOn('kiro'), guard: { maintenance: failed(), chat: failed({ toolset: 'chat' }) } };
    await mount(both);
    api.retryMetaAgentGuard.mockRejectedValue(new MetaAgentApiError(500, 'Database is locked'));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }));
    await flush();
    expect(api.retryMetaAgentGuard).toHaveBeenCalledWith(undefined);
    expect(screen.getByText(/Meta agent stopped/)).toBeTruthy();
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', false);
  });

  it('opens the details and moves to the runtime choice', async () => {
    await mount({ ...followOn('kiro'), guard: { maintenance: failed(), chat: failed({ toolset: 'chat', unexpectedTools: ['fs_write'], detail: undefined }) } });
    const alert = screen.getByRole('alert');
    expect(within(alert).getAllByText(/^(execute_bash|fs_write)$/)).toHaveLength(2);
    expect(within(alert).queryByText('Background maintenance')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Details' }));
    expect(within(alert).getByText('Background maintenance')).toBeTruthy();
    expect(within(alert).getByText('Chat window')).toBeTruthy();
    expect(alert.textContent).toContain('Kiro published 2 tools outside the allow-list');
    expect(alert.textContent).toMatch(/Kiro · checked [A-Z][a-z]{2} \d{1,2}, \d{2}:41/);

    fireEvent.click(within(alert).getByRole('button', { name: 'Change runtime' }));
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Custom/ }));
  });

  it('has no red box while every check passed', async () => {
    await mount({ ...followOn('kiro'), guard: { maintenance: { ...failed(), state: 'ok', unexpectedTools: [] }, chat: null } });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Settings › Meta agent background updates', () => {
  const row = () => screen.getByRole('switch', { name: 'Background updates' }).closest('.meta-set__row') as HTMLElement;

  it('pauses and resumes them through the same switch as Scheduled, and says the chat window still works', async () => {
    await mount();
    expect(row().textContent).toContain('Checks every workspace for new conversations every 60 seconds');
    expect(within(row()).getByText('On')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Background updates' }).getAttribute('aria-checked')).toBe('true');

    api.setPaused.mockResolvedValue(overview('paused'));
    fireEvent.click(screen.getByRole('switch', { name: 'Background updates' }));
    await flush();
    expect(api.setPaused).toHaveBeenCalledWith(true);
    expect(within(row()).getByText('Paused')).toBeTruthy();
    expect(row().textContent).toContain('The chat window in Pages still works.');
    expect(screen.getByRole('heading', { name: 'Reading' }).parentElement!.textContent).toBe('ReadingSaved');

    api.setPaused.mockResolvedValue(overview('running'));
    fireEvent.click(screen.getByRole('switch', { name: 'Background updates' }));
    await flush();
    expect(api.setPaused).toHaveBeenLastCalledWith(false);
    expect(within(row()).getByText('On')).toBeTruthy();
  });

  it('shows a failed change in its section and reads the state again', async () => {
    await mount();
    api.setPaused.mockRejectedValue(new Error('Scheduler is off'));
    fireEvent.click(screen.getByRole('switch', { name: 'Background updates' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Scheduler is off');
    expect(screen.getByRole('alert').closest('section')!.querySelector('h2')!.textContent).toBe('Reading');
    expect(api.fetchOverview.mock.calls.length).toBeGreaterThan(1);
    expect(within(row()).getByText('On')).toBeTruthy();
  });
});

describe('Settings › Meta agent reading, writing and usage', () => {
  it('shows the fixed rows, the locked rule, the defaults and today’s usage', async () => {
    await mount({ ...FOLLOW, usageToday: { checks: 342, modelCalls: 9, tokens: 41_200 } });
    expect(await screen.findByText(/Checks every workspace for new conversations every 60 seconds/)).toBeTruthy();
    expect(screen.getByText('Last 30 days of conversations, up to 1,000')).toBeTruthy();
    expect(screen.getByText('Scheduled-job output, the Meta agent’s own chat, and archived or deleted conversations')).toBeTruthy();
    const range = screen.getByRole('combobox', { name: 'First-run range' }) as HTMLSelectElement;
    expect(range.disabled).toBe(false);
    expect(range.value).toBe('30');
    expect([...range.options].map((option) => option.value)).toEqual(['7', '30', '90']);
    for (const name of ['Write workspace homes', 'Maintain the Pages home']) {
      const control = screen.getByRole('switch', { name });
      expect(control.getAttribute('aria-checked'), `${name} is on by default`).toBe('true');
      expect(control).toHaveProperty('disabled', false);
    }
    const locked = screen.getByRole('switch', { name: 'Human-edited blocks only get suggestions' });
    expect(locked.getAttribute('aria-checked')).toBe('true');
    expect(locked).toHaveProperty('disabled', true);
    expect(screen.getByText('Today: 342 checks, 9 AI calls, about 41k tokens.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bFixed\b|cursor|runtime\b|model call|same as Michi/);
  });

  it('says “Saved” beside the section that changed, for a moment, and not after a failed save', async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const head = (title: string) => screen.getByRole('heading', { name: title }).parentElement!;
      api.updateMetaAgentSettings.mockResolvedValue({ ...FOLLOW, settings: { ...FOLLOW.settings, writeWorkspaceHomes: false } });
      fireEvent.click(screen.getByRole('switch', { name: 'Write workspace homes' }));
      await flush();
      expect(head('Writing').textContent).toBe('WritingSaved');
      expect(head('Reading').textContent).toBe('Reading');
      expect(head('Runtime').textContent).toBe('Runtime');

      api.updateMetaAgentSettings.mockResolvedValue({ ...CUSTOM_CODEX });
      fireEvent.click(screen.getByRole('radio', { name: /Custom/ }));
      await flush();
      expect(head('Runtime').textContent).toBe('RuntimeSaved');
      expect(head('Writing').textContent).toBe('Writing');
      act(() => { vi.advanceTimersByTime(2_000); });
      expect(head('Runtime').textContent).toBe('Runtime');

      api.updateMetaAgentSettings.mockRejectedValue(new MetaAgentApiError(400, 'Unknown runtime'));
      fireEvent.click(screen.getByRole('button', { name: 'Kiro' }));
      await flush();
      expect(head('Runtime').textContent).toBe('Runtime');
      expect(screen.getByRole('alert').textContent).toBe('Unknown runtime');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the write switches and the first-run range', async () => {
    await mount();
    api.updateMetaAgentSettings.mockResolvedValue({ ...FOLLOW, settings: { ...FOLLOW.settings, writeWorkspaceHomes: false } });
    fireEvent.click(screen.getByRole('switch', { name: 'Write workspace homes' }));
    await flush();
    expect(lastPatch()).toEqual({ writeWorkspaceHomes: false });
    expect(screen.getByRole('switch', { name: 'Write workspace homes' }).getAttribute('aria-checked')).toBe('false');

    api.updateMetaAgentSettings.mockResolvedValue({ ...FOLLOW, settings: { ...FOLLOW.settings, writeWorkspaceHomes: false, maintainSpacesHome: false } });
    fireEvent.click(screen.getByRole('switch', { name: 'Maintain the Pages home' }));
    await flush();
    expect(lastPatch()).toEqual({ maintainSpacesHome: false });
    expect(screen.getByRole('switch', { name: 'Maintain the Pages home' }).getAttribute('aria-checked')).toBe('false');

    api.updateMetaAgentSettings.mockResolvedValue({ ...FOLLOW, settings: { ...FOLLOW.settings, firstRunDays: 7 } });
    fireEvent.change(screen.getByRole('combobox', { name: 'First-run range' }), { target: { value: '7' } });
    await flush();
    expect(lastPatch()).toEqual({ firstRunDays: 7 });
    expect(screen.getByText('Last 7 days of conversations, up to 1,000')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'First-run range' }) as HTMLSelectElement).value).toBe('7');
  });

  it('keeps the reading and writing settings when going back to the global runtime', async () => {
    await mount({ ...CUSTOM_CODEX, settings: { ...CUSTOM_CODEX.settings, writeWorkspaceHomes: false, firstRunDays: 90 } });
    api.updateMetaAgentSettings.mockResolvedValue(FOLLOW);
    fireEvent.click(screen.getByRole('radio', { name: /Follow global settings/ }));
    await flush();
    expect(lastPatch()).toEqual({ runtimeId: null, providerId: null, modelId: null, reasoning: null });
  });

  it('says when tokens were not reported, and when usage could not be counted', async () => {
    await mount({ ...FOLLOW, usageToday: { checks: 1, modelCalls: 0, tokens: null } });
    expect(screen.getByText('Today: 1 check, 0 AI calls; the AI service didn’t say how many tokens it used.')).toBeTruthy();
    cleanup();
    resetMetaAgentStore();
    await mount({ ...FOLLOW, usageToday: null });
    expect(screen.getByText('Today’s usage could not be counted.')).toBeTruthy();
  });
});

describe('Settings › Meta agent without a backend', () => {
  it('shows a quiet notice on 404', async () => {
    await mount(new MetaAgentApiError(404, 'Not found'));
    expect(screen.getByRole('status').textContent).toContain('does not run the Meta agent yet');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports other failures with a retry', async () => {
    await mount(new MetaAgentApiError(500, 'Database is locked'));
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load the Meta agent: Database is locked.');
    api.fetchMetaAgent.mockReset();
    api.fetchMetaAgent.mockResolvedValue(FOLLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getByRole('radio', { name: /Follow global settings/ })).toBeTruthy();
  });
});

it('shows pending tool approval and saves persistent approval, then revokes it', async () => {
  const request = { id: 'abc', server: 'mail', tool: 'send', description: 'Send a message', state: 'pending' as const, requestedAt: 1, updatedAt: 1 };
  await mount({ ...FOLLOW, toolApprovals: [request] });
  expect(screen.getByText(/Needs your approval; not executed/)).toBeTruthy();
  api.decideMetaAgentToolApproval.mockResolvedValue({ ...FOLLOW, toolApprovals: [{ ...request, state: 'approved' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Always allow this tool' })); await flush();
  expect(api.decideMetaAgentToolApproval).toHaveBeenLastCalledWith('abc', 'approved');
  api.decideMetaAgentToolApproval.mockResolvedValue({ ...FOLLOW, toolApprovals: [{ ...request, state: 'revoked' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' })); await flush();
  expect(api.decideMetaAgentToolApproval).toHaveBeenLastCalledWith('abc', 'revoked');
});
