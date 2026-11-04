import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MemoryChangedEvent, MemoryRecord, MemoryScope, MemoryStatus } from 'michi-shared';
import type { MemoryChangeSubscription, MemoryExtractionStatus, MemoryListQuery } from '../../../../services/api/memories';
import { MemoryApiError } from '../../../../services/api/memories';
import { readMemoryBadge, resetMemoryNotifications, useMemoryNotifications } from '../../../../state/memory/memoryNotifications';
import { MemoryPane } from './MemoryPane';

/** A small stand-in for the backend's memory store and routes. */
const backend = vi.hoisted(() => ({
  records: [] as MemoryRecord[],
  mode: 'explicit' as 'off' | 'explicit' | 'auto',
  extraction: null as MemoryExtractionStatus | null,
  settingsError: null as Error | null,
  subscriptions: [] as MemoryChangeSubscription[],
  calls: [] as string[],
}));
const nav = vi.hoisted(() => ({
  selectProject: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), activateTree: vi.fn(), setFocusedNodeId: vi.fn(),
  projects: [] as Array<Record<string, unknown>>,
  activeProjectId: 'ws-1' as string | null,
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('../../../../state/chatStore', () => ({
  useChatProjects: () => ({
    projects: nav.projects,
    activeProjectId: nav.activeProjectId,
    activeProject: nav.projects.find((project) => project.id === nav.activeProjectId) ?? null,
  }),
  useChatActions: () => ({
    selectProject: nav.selectProject, openPane: nav.openPane, openPaneInTree: nav.openPaneInTree,
    activateTree: nav.activateTree, setFocusedNodeId: nav.setFocusedNodeId,
  }),
}));
vi.mock('../../../../services/api/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/api/memories')>();
  const find = (id: string) => {
    const record = backend.records.find((item) => item.id === id);
    if (!record) throw new actual.MemoryApiError(404, 'Memory not found', { code: 'not_found' });
    return record;
  };
  const matches = (record: MemoryRecord, query: MemoryListQuery) => {
    const statuses: readonly MemoryStatus[] = query.status ?? ['active', 'pending'];
    if (!statuses.includes(record.status)) return false;
    if (query.scope === 'user' && record.scope.kind !== 'user') return false;
    if (query.scope === 'workspace' && (record.scope.kind !== 'workspace' || (query.workspaceId && record.scope.workspaceId !== query.workspaceId))) return false;
    return !query.q || query.q.split(/\s+/).every((term) => record.body.includes(term));
  };
  let next = 100;
  return {
    ...actual,
    listMemories: vi.fn(async (query: MemoryListQuery = {}) => {
      backend.calls.push(`list ${JSON.stringify({ ...query, signal: undefined })}`);
      const items = backend.records.filter((record) => matches(record, query)).sort((a, b) => b.createdAt - a.createdAt);
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      return { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : null };
    }),
    updateMemory: vi.fn(async (id: string, patch: { body?: string; scope?: MemoryScope; expectedVersion: number }) => {
      const record = find(id);
      if (record.version !== patch.expectedVersion) {
        throw new actual.MemoryApiError(409, 'The memory changed since it was read', { code: 'version_conflict', currentVersion: record.version });
      }
      Object.assign(record, patch.body !== undefined ? { body: patch.body } : {}, patch.scope ? { scope: patch.scope } : {});
      record.version += 1;
      record.updatedAt = Date.now();
      return { ...record };
    }),
    deleteMemory: vi.fn(async (id: string) => { find(id); backend.records = backend.records.filter((item) => item.id !== id); }),
    approveMemory: vi.fn(async (id: string) => {
      const record = find(id);
      if (record.status !== 'pending') throw new actual.MemoryApiError(409, 'Only a pending memory can be approved', { code: 'invalid_state' });
      record.status = 'active';
      record.version += 1;
      return { ...record };
    }),
    rejectMemory: vi.fn(async (id: string) => { find(id); backend.records = backend.records.filter((item) => item.id !== id); }),
    createMemory: vi.fn(async (input: { scope: MemoryScope; kind: MemoryRecord['kind']; body: string }) => {
      if (backend.mode === 'off') throw new actual.MemoryApiError(409, 'Memory is turned off', { code: 'memory_disabled' });
      const record = memory(`mem-new-${next}`, input.body, { scope: input.scope, kind: input.kind, createdAt: next++ });
      backend.records.push(record);
      return { ...record };
    }),
    fetchMemorySettings: vi.fn(async () => {
      if (backend.settingsError) throw backend.settingsError;
      return { mode: backend.mode };
    }),
    saveMemorySettings: vi.fn(async (mode: typeof backend.mode) => { backend.mode = mode; return { mode }; }),
    fetchMemoryExtractionStatus: vi.fn(async () => backend.extraction),
    setMemoryExtractionPaused: vi.fn(async (paused: boolean) => {
      backend.extraction = backend.extraction ? { ...backend.extraction, paused } : null;
      return backend.extraction;
    }),
    subscribeMemoryChanges: (options: MemoryChangeSubscription) => { backend.subscriptions.push(options); return () => {}; },
  };
});

import * as api from '../../../../services/api/memories';

function memory(id: string, body: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, ownerUserId: 'local', scope: { kind: 'user' }, kind: 'preference', body, source: null, status: 'active',
    origin: 'explicit', version: 1, supersedesId: null, sourceRisk: null, createdAt: 1, updatedAt: Date.now() - 5 * 60_000, ...overrides,
  };
}

const list = (name: string) => screen.getByRole('list', { name });
const item = (listName: string, text: string) => within(list(listName)).getByRole('listitem', { name: text });
const savedBodies = () => within(list('Saved memories')).getAllByRole('listitem').map((row) => row.querySelector('.memory-item__body')?.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  resetMemoryNotifications();
  backend.mode = 'explicit';
  backend.extraction = null;
  backend.settingsError = null;
  backend.subscriptions = [];
  backend.calls = [];
  backend.records = [
    memory('mem-user', 'Answer in Chinese', { createdAt: 3, origin: 'explicit' }),
    memory('mem-ws', 'Use 2 spaces in this repo', { createdAt: 2, kind: 'convention', origin: 'extracted', scope: { kind: 'workspace', workspaceId: 'ws-1' }, source: { nodeId: 'n-1' } }),
    memory('mem-other', 'Beta deploys on Fridays', { createdAt: 1, kind: 'fact', scope: { kind: 'workspace', workspaceId: 'ws-2' } }),
  ];
  nav.projects = [
    { id: 'ws-1', name: 'Alpha', chatIds: ['n-1'], trees: [{ id: 't-1', rootNodeId: 'n-1' }], edges: [], activeTreeId: 't-1' },
    { id: 'ws-2', name: 'Beta', chatIds: [], trees: [], edges: [], activeTreeId: null },
  ];
  nav.activeProjectId = 'ws-1';
  for (const fn of [nav.selectProject, nav.openPane, nav.openPaneInTree, nav.activateTree, nav.setFocusedNodeId]) fn.mockReset();
});
afterEach(() => {
  cleanup();
  resetMemoryNotifications();
});

describe('Settings › Memory', () => {
  it('lists saved memories with kind, scope, origin and update time, and filters by scope and search', async () => {
    render(<MemoryPane />);
    await waitFor(() => expect(savedBodies()).toEqual(['Answer in Chinese', 'Use 2 spaces in this repo', 'Beta deploys on Fridays']));
    const ws = item('Saved memories', 'Use 2 spaces in this repo');
    expect(ws.querySelector('.memory-item__meta')?.textContent).toBe('ConventionAlphaAutomaticUpdated 5m agoOpen conversation');
    expect(item('Saved memories', 'Answer in Chinese').querySelector('.memory-item__meta')?.textContent).toContain('PreferenceGlobalExplicit');
    expect(item('Saved memories', 'Beta deploys on Fridays').textContent).toContain('Beta');

    const filter = screen.getByRole('combobox', { name: 'Show memories' });
    expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual(['All memories', 'Global only', 'Alpha only']);
    fireEvent.change(filter, { target: { value: 'user' } });
    await waitFor(() => expect(savedBodies()).toEqual(['Answer in Chinese']));
    fireEvent.change(filter, { target: { value: 'workspace' } });
    await waitFor(() => expect(savedBodies()).toEqual(['Use 2 spaces in this repo']));
    expect(backend.calls).toContain(`list ${JSON.stringify({ status: ['active'], scope: 'workspace', workspaceId: 'ws-1', limit: 50 })}`);

    fireEvent.change(filter, { target: { value: 'all' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search memories' }), { target: { value: 'Fridays' } });
    await waitFor(() => expect(savedBodies()).toEqual(['Beta deploys on Fridays']));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search memories' }), { target: { value: 'nothing like it' } });
    expect(await screen.findByText('No memories match “nothing like it”.')).toBeTruthy();
  });

  it('offers no workspace filter while the open workspace is on another machine', async () => {
    nav.projects = [{ id: 'remote:dd:ws-9', name: 'Remote', chatIds: [], backendConnectionId: 'dd' }];
    nav.activeProjectId = 'remote:dd:ws-9';
    render(<MemoryPane />);
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    expect(within(screen.getByRole('combobox', { name: 'Show memories' })).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['All memories', 'Global only']);
  });

  it('edits a memory inline', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Answer in Chinese'));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(row).getByRole('textbox', { name: 'Edit memory' }), { target: { value: 'Answer in Chinese, code in English' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedBodies()[0]).toBe('Answer in Chinese, code in English'));
    expect(api.updateMemory).toHaveBeenCalledWith('mem-user', { body: 'Answer in Chinese, code in English', expectedVersion: 1 });
  });

  it('on a conflict, reloads and shows the current text instead of overwriting it', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Answer in Chinese'));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    // Meanwhile an agent corrects the same memory.
    Object.assign(backend.records[0], { body: 'Answer in Japanese', version: 2 });
    fireEvent.change(within(row).getByRole('textbox', { name: 'Edit memory' }), { target: { value: 'Answer in French' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect((await within(row).findByRole('alert')).textContent).toBe('This memory changed somewhere else, so your edit wasn’t saved. Its current text is shown.');
    expect((within(row).getByRole('textbox', { name: 'Edit memory' }) as HTMLTextAreaElement).value).toBe('Answer in Japanese');
    expect(backend.records[0].body).toBe('Answer in Japanese');
    // Saving again applies to the version now shown.
    fireEvent.change(within(row).getByRole('textbox', { name: 'Edit memory' }), { target: { value: 'Answer in French' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend.records[0].body).toBe('Answer in French'));
    expect(api.updateMemory).toHaveBeenLastCalledWith('mem-user', { body: 'Answer in French', expectedVersion: 2 });
  });

  it('says so when the memory being edited was deleted elsewhere', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Answer in Chinese'));
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    backend.records = backend.records.filter((record) => record.id !== 'mem-user');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedBodies()).not.toContain('Answer in Chinese'));
  });

  it('deletes a memory after a confirmation', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Beta deploys on Fridays'));
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(api.deleteMemory).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(savedBodies()).toEqual(['Answer in Chinese', 'Use 2 spaces in this repo']));
    expect(api.deleteMemory).toHaveBeenCalledExactlyOnceWith('mem-other');
  });

  it('changes a memory’s scope between global and the open workspace', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Saved memories', 'Use 2 spaces in this repo'));
    const scope = within(row).getByRole('combobox', { name: 'Scope' });
    expect(within(scope).getAllByRole('option').map((option) => option.textContent)).toEqual(['Global', 'Alpha']);
    fireEvent.change(scope, { target: { value: 'user' } });
    await waitFor(() => expect(item('Saved memories', 'Use 2 spaces in this repo').querySelector('.memory-item__meta')?.textContent).toContain('ConventionGlobal'));
    expect(api.updateMemory).toHaveBeenCalledWith('mem-ws', { scope: { kind: 'user' }, expectedVersion: 1 });
    // Another workspace's memory keeps its own workspace as a choice.
    const other = within(item('Saved memories', 'Beta deploys on Fridays')).getByRole('combobox', { name: 'Scope' });
    expect(within(other).getAllByRole('option').map((option) => option.textContent)).toEqual(['Global', 'Alpha', 'Beta']);
  });

  it('opens the source conversation on request', async () => {
    const onNav = vi.fn();
    render(<MemoryPane onNav={onNav} />);
    const row = await waitFor(() => item('Saved memories', 'Use 2 spaces in this repo'));
    expect(within(item('Saved memories', 'Answer in Chinese')).queryByRole('button', { name: 'Open conversation' })).toBeNull();
    expect(nav.openPane).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Open conversation' }));
    expect(nav.openPane).toHaveBeenCalledWith('n-1');
    expect(nav.setFocusedNodeId).toHaveBeenCalledWith('n-1');
    expect(nav.selectProject).not.toHaveBeenCalled();
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it('adds a memory by hand, and not while memory is off', async () => {
    render(<MemoryPane />);
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    const form = screen.getByRole('group', { name: 'Add memory' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'New memory' }), { target: { value: 'Prefer small commits' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Kind' }), { target: { value: 'convention' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'New memory scope' }), { target: { value: 'workspace:ws-1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save memory' }));
    await waitFor(() => expect(savedBodies()[0]).toBe('Prefer small commits'));
    expect(api.createMemory).toHaveBeenCalledWith({ scope: { kind: 'workspace', workspaceId: 'ws-1' }, kind: 'convention', body: 'Prefer small commits' });

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Add memory' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('Turn memory on to add memories.')).toBeTruthy();
  });

  it('changes the mode, and says turning it off keeps chat history', async () => {
    render(<MemoryPane />);
    const group = await screen.findByRole('radiogroup', { name: 'Memory mode' });
    expect(within(group).getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual(['Off', 'Explicit only', 'Automatic']);
    expect((within(group).getByRole('radio', { name: 'Explicit only' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Turning memory off doesn’t delete chat history. Conversations are kept as before.')).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: 'Off' }));
    await waitFor(() => expect(api.saveMemorySettings).toHaveBeenCalledWith('off'));
    expect((within(group).getByRole('radio', { name: 'Off' }) as HTMLInputElement).checked).toBe(true);
    // Saved memories stay listed with memory off.
    expect(savedBodies()).toHaveLength(3);
  });

  it('puts the mode back when saving it fails', async () => {
    vi.mocked(api.saveMemorySettings).mockRejectedValueOnce(new Error('offline'));
    render(<MemoryPane />);
    const group = await screen.findByRole('radiogroup', { name: 'Memory mode' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Automatic' }));
    expect((await screen.findByText('Couldn’t change the memory mode: offline'))).toBeTruthy();
    expect((within(group).getByRole('radio', { name: 'Explicit only' }) as HTMLInputElement).checked).toBe(true);
  });

  it('shows automatic memory’s status in automatic mode, with pause and resume', async () => {
    backend.mode = 'auto';
    backend.extraction = { enabled: true, paused: false, lastRunAt: Date.now() - 2 * 3600_000, lastError: 'model timed out', pendingCount: 1, todayTokens: 1200, dailyTokenLimit: 50000 };
    render(<MemoryPane />);
    const section = (await screen.findByRole('heading', { name: 'Automatic memory' })).closest('section')!;
    await waitFor(() => expect(within(section).getByText('Running')).toBeTruthy());
    expect(within(section).getByText('2h ago')).toBeTruthy();
    expect(within(section).getByRole('alert').textContent).toBe('Last error: model timed out');
    expect(within(section).getByText('1,200 of 50,000 tokens')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Pause automatic memory' }));
    await waitFor(() => expect(within(section).getByText('Paused')).toBeTruthy());
    expect(api.setMemoryExtractionPaused).toHaveBeenCalledWith(true);
    fireEvent.click(within(section).getByRole('button', { name: 'Resume automatic memory' }));
    await waitFor(() => expect(within(section).getByText('Running')).toBeTruthy());
    expect(api.setMemoryExtractionPaused).toHaveBeenLastCalledWith(false);
  });

  it('explains why automatic memory is held, and offers resume only where it helps', async () => {
    backend.mode = 'auto';
    const base = { enabled: true, paused: false, lastRunAt: null, lastError: null, pendingCount: 0, todayTokens: 0, dailyTokenLimit: 1000 };
    backend.extraction = { ...base, state: 'stopped', stateReason: 'Runs stopped after 5 failures in “Docs”.' };
    const { unmount } = render(<MemoryPane />);
    let section = (await screen.findByRole('heading', { name: 'Automatic memory' })).closest('section')!;
    await waitFor(() => expect(within(section).getByText('Stopped')).toBeTruthy());
    expect(within(section).getByText('Runs stopped after 5 failures in “Docs”.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Resume automatic memory' }));
    expect(api.setMemoryExtractionPaused).toHaveBeenLastCalledWith(false);
    unmount();

    backend.extraction = { ...base, state: 'unsupported', supported: false, stateReason: 'Kiro Crew can’t run the Meta agent.' };
    render(<MemoryPane />);
    section = (await screen.findByRole('heading', { name: 'Automatic memory' })).closest('section')!;
    await waitFor(() => expect(within(section).getByText('Unsupported')).toBeTruthy());
    expect(within(section).getByText('Kiro Crew can’t run the Meta agent.')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: /automatic memory/ })).toBeNull();
  });

  it('shows automatic memory as unavailable on a backend without it, and hides it in other modes', async () => {
    backend.mode = 'auto';
    backend.extraction = null;
    render(<MemoryPane />);
    expect(await screen.findByText('This Michi backend can’t suggest memories yet. Agents still save memories when you ask.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /automatic memory/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Explicit only' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Automatic memory' })).toBeNull());
  });

  it('says so when this backend has no Memory at all', async () => {
    backend.settingsError = new MemoryApiError(404, 'Not found');
    render(<MemoryPane />);
    expect(await screen.findByText('This Michi backend doesn’t support Memory yet. Its settings appear here once it does.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('Settings › Memory: waiting for confirmation', () => {
  beforeEach(() => {
    backend.records.push(
      memory('p-web', 'The API key is in the README', { createdAt: 10, status: 'pending', sourceRisk: 'untrusted', kind: 'fact', origin: 'explicit' }),
      memory('p-a', 'Run tests with pnpm', { createdAt: 9, status: 'pending', origin: 'extracted', kind: 'convention', scope: { kind: 'workspace', workspaceId: 'ws-1' } }),
      memory('p-b', 'Prefers dark mode', { createdAt: 8, status: 'pending', origin: 'extracted' }),
    );
  });

  it('lists pending memories apart from saved ones, warns about untrusted sources and updates the badge', async () => {
    render(<MemoryPane />);
    const pending = await screen.findByRole('list', { name: 'Waiting for confirmation' });
    expect(within(pending).getAllByRole('listitem')).toHaveLength(3);
    expect(savedBodies()).not.toContain('Run tests with pnpm');
    expect(readMemoryBadge().pendingCount).toBe(3);
    expect(item('Waiting for confirmation', 'The API key is in the README').querySelector('.memory-item__warning')?.textContent)
      .toBe('Saved while an agent was reading web pages or tool output. Check that it says what you want before approving it.');
    expect(item('Waiting for confirmation', 'Run tests with pnpm').querySelector('.memory-item__warning')).toBeNull();
  });

  it('approves and rejects one at a time', async () => {
    render(<MemoryPane />);
    const row = await waitFor(() => item('Waiting for confirmation', 'Run tests with pnpm'));
    fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(savedBodies()).toContain('Run tests with pnpm'));
    expect(api.approveMemory).toHaveBeenCalledExactlyOnceWith('p-a');
    expect(within(list('Waiting for confirmation')).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(item('Waiting for confirmation', 'Prefers dark mode')).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(within(list('Waiting for confirmation')).getAllByRole('listitem')).toHaveLength(1));
    expect(api.rejectMemory).toHaveBeenCalledExactlyOnceWith('p-b');
    expect(savedBodies()).not.toContain('Prefers dark mode');
    expect(readMemoryBadge().pendingCount).toBe(1);
  });

  it('approves or rejects the selected ones together, and the section goes once none wait', async () => {
    render(<MemoryPane />);
    await screen.findByRole('list', { name: 'Waiting for confirmation' });
    const approveSelected = () => screen.getByRole('button', { name: /^Approve selected/ }) as HTMLButtonElement;
    expect(approveSelected().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Run tests with pnpm”' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select “Prefers dark mode”' }));
    expect(approveSelected().textContent).toBe('Approve selected (2)');
    fireEvent.click(approveSelected());
    await waitFor(() => expect(within(list('Waiting for confirmation')).getAllByRole('listitem')).toHaveLength(1));
    expect(vi.mocked(api.approveMemory).mock.calls.map(([id]) => id)).toEqual(['p-a', 'p-b']);
    expect(savedBodies()).toEqual(expect.arrayContaining(['Run tests with pnpm', 'Prefers dark mode']));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject selected (1)' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Waiting for confirmation' })).toBeNull());
    expect(api.rejectMemory).toHaveBeenCalledExactlyOnceWith('p-web');
    expect(readMemoryBadge().pendingCount).toBe(0);
  });

  it('reports the ones that failed in a bulk decision and keeps them listed', async () => {
    vi.mocked(api.approveMemory).mockImplementationOnce(async () => { throw new Error('database is locked'); });
    render(<MemoryPane />);
    await screen.findByRole('list', { name: 'Waiting for confirmation' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected (3)' }));
    expect((await screen.findByText('Couldn’t approve 1 of 3 memories: database is locked'))).toBeTruthy();
    await waitFor(() => expect(within(list('Waiting for confirmation')).getAllByRole('listitem')).toHaveLength(1));
  });
});

describe('Settings › Memory: changes made elsewhere', () => {
  function Feed() {
    useMemoryNotifications(() => {});
    return null;
  }
  const announce = (event: Partial<MemoryChangedEvent>) => act(() => backend.subscriptions[0].onEvent({
    ownerUserId: 'local', workspaceId: null, memoryId: 'x', action: 'created', status: 'active', body: '', origin: 'explicit', supersedesId: null, ...event,
  }));

  it('refreshes both lists when an agent saves or proposes a memory, without moving focus', async () => {
    render(<><Feed /><MemoryPane /></>);
    const search = await screen.findByRole('searchbox', { name: 'Search memories' });
    await waitFor(() => expect(savedBodies()).toHaveLength(3));
    search.focus();
    backend.records.push(
      memory('mem-agent', 'Use Vitest, not Jest', { createdAt: 20 }),
      memory('p-new', 'Ship on Tuesdays', { createdAt: 21, status: 'pending' }),
    );
    announce({ memoryId: 'mem-agent', body: 'Use Vitest, not Jest' });
    announce({ memoryId: 'p-new', status: 'pending', body: 'Ship on Tuesdays' });
    await waitFor(() => expect(savedBodies()[0]).toBe('Use Vitest, not Jest'));
    expect(await screen.findByRole('list', { name: 'Waiting for confirmation' })).toBeTruthy();
    expect(document.activeElement).toBe(search);
  });
});
