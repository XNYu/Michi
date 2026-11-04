import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import type { MetaAgentInfo } from '../../../services/api/metaAgent';
import { resetMetaAgentStore } from '../../../state/metaAgent/useMetaAgent';
import { notePendingMemories, resetMemoryNotifications } from '../../../state/memory/memoryNotifications';
import { AreaRail } from './AreaRail';
import { useRailBadges } from './useRailBadges';

const api = vi.hoisted(() => ({ fetchMetaAgent: vi.fn(), firstRun: null as unknown, finished: [] as Array<(connectionId: string, status: unknown) => void>, toastSuccess: vi.fn(),
  conversations: { scheduledRunning: false, conversationsDone: false }, sections: null as unknown, sectionsSince: [] as unknown[] }));
vi.mock('../../../services/api/metaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/metaAgent')>()),
  fetchMetaAgent: api.fetchMetaAgent,
}));
vi.mock('sonner', () => ({ toast: { success: api.toastSuccess } }));
vi.mock('../../../state/pages/useSpacesHome', () => ({
  useHomeSections: (...args: unknown[]) => { api.sectionsSince.push(args); return { data: api.sections, status: 'ready', error: null, stale: false, refresh: () => {} }; },
}));
vi.mock('../../../state/chatStore', () => ({
  useOptionalChatProjects: () => null,
  useStructuralSelector: (select: (nodes: unknown) => unknown) => select({}),
}));
vi.mock('../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: api.firstRun, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
  subscribeFirstRunFinished: (listener: (connectionId: string, status: unknown) => void) => {
    api.finished.push(listener);
    return () => { api.finished = api.finished.filter((item) => item !== listener); };
  },
}));
vi.mock('../spaces/home/homeLinks', () => ({ useSpaceConversationBadges: () => api.conversations }));

const INFO: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  api.fetchMetaAgent.mockReset();
  api.firstRun = null;
  api.conversations = { scheduledRunning: false, conversationsDone: false };
  api.finished = [];
  api.sections = null;
  api.sectionsSince = [];
  api.toastSuccess.mockReset();
  resetMetaAgentStore();
  resetMemoryNotifications();
});

const workspace = (id: string, state: string, total: number) => ({
  workspaceId: id, workspaceName: id, homePageId: null, hiddenAt: null,
  firstRun: { workspaceId: id, startedAt: 1, startSeq: 1, readCount: 0, total, state, error: state === 'failed' ? 'x' : null, updatedAt: 1 },
});
afterEach(() => cleanup());

describe('useRailBadges', () => {
  it('puts a red dot on Settings while a Meta agent restriction check failed', async () => {
    api.fetchMetaAgent.mockResolvedValue({
      ...INFO,
      guard: { maintenance: { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['fs_write'], checkedAt: 1 }, chat: null },
    });
    const { result } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current.settingsAlert).toBe(true);
    render(<AreaRail area="spaces" onSelect={() => {}} badges={result.current} />);
    expect(screen.getByRole('button', { name: 'Settings, needs attention' })).toBeTruthy();
  });

  it('counts memories waiting for approval on Settings, unless the Meta agent needs attention', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    const { result } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current.memoryPending).toBe(0);
    act(() => notePendingMemories(2));
    expect(result.current.memoryPending).toBe(2);
    const view = render(<AreaRail area="spaces" onSelect={() => {}} badges={result.current} />);
    const settings = screen.getByRole('button', { name: 'Settings, 2 memories waiting for confirmation' });
    expect(settings.querySelector('.area-rail__count')?.textContent).toBe('2');
    view.rerender(<AreaRail area="spaces" onSelect={() => {}} badges={{ ...result.current, memoryPending: 1, settingsAlert: true }} />);
    expect(screen.getByRole('button', { name: 'Settings, needs attention' }).querySelector('.area-rail__count')).toBeNull();
  });

  it('keeps Settings plain when the checks passed', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    const { result } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current.settingsAlert).toBe(false);
  });

  it('shows the Space conversations’ dots: Scheduled while one runs, Conversations once one finished unseen', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    api.conversations = { scheduledRunning: true, conversationsDone: true };
    const { result } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current).toMatchObject({ scheduledRunning: true, conversationsDone: true });
    render(<AreaRail area="spaces" onSelect={() => {}} badges={result.current} />);
    expect(screen.getByRole('button', { name: 'Conversations, finished' })).toBeTruthy();
  });

  it('puts the yellow dot on Scheduled while the first run reads the history', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    api.firstRun = { requestedAt: 1, workspaces: [workspace('a', 'reading', 3)], summary: { state: 'waiting', summarizedAt: null }, haltedReason: null };
    const { result, rerender } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current.scheduledRunning).toBe(true);
    render(<AreaRail area="spaces" onSelect={() => {}} badges={result.current} />);
    expect(screen.getByRole('button', { name: 'Scheduled, running' })).toBeTruthy();
    api.firstRun = { requestedAt: 1, workspaces: [workspace('a', 'done', 3)], summary: { state: 'done', summarizedAt: 2 }, haltedReason: null };
    rerender();
    expect(result.current.scheduledRunning).toBe(false);
  });

  it('keeps Scheduled plain while a Spaces Home summary runs after the first run', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    api.firstRun = { requestedAt: 1, workspaces: [workspace('a', 'done', 3)], summary: { state: 'running', summarizedAt: 2 }, haltedReason: null, closed: true };
    const { result } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current.scheduledRunning).toBe(false);
  });

  it('shows one toast when every first read ends, however many readers the badges have', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    renderHook(() => { useRailBadges(); useRailBadges(); });
    await flush();
    expect(api.finished).toHaveLength(1);
    act(() => api.finished[0]('local', {
      requestedAt: 1, workspaces: [workspace('a', 'done', 3), workspace('b', 'done', 2), workspace('c', 'failed', 4)],
      summary: { state: 'done', summarizedAt: 2 }, haltedReason: null,
    }));
    expect(api.toastSuccess).toHaveBeenCalledWith(
      'Meta agent finished: 2 workspace homes + the Pages Home (1 not written); from now on it reads only new conversations',
    );
  });
  it('suppresses Pages reminders without fetching Home sections for a badge', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    const section = (total: number) => ({ items: [], total });
    api.sections = { waiting: section(5), stalled: section(2), done: section(1), conversations: { available: true } };
    const { result } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current.spacesWaiting).toBe(0);
    expect(api.sectionsSince).toEqual([]);
    render(<AreaRail area="conversations" onSelect={() => {}} badges={result.current} />);
    expect(screen.getByRole('button', { name: 'Pages' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pages,.*waiting/ })).toBeNull();
  });

  it('shows no Spaces count until the Home sections are read', async () => {
    api.fetchMetaAgent.mockResolvedValue(INFO);
    const { result } = renderHook(() => useRailBadges());
    await flush();
    expect(result.current.spacesWaiting).toBe(0);
  });
});
