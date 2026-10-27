import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { HomeConversationItem, HomeSectionKey } from 'michi-shared';

const mocks = vi.hoisted(() => ({
  list: null as null | { items: HomeConversationItem[]; total: number },
  status: 'ready' as 'loading' | 'ready' | 'error',
  error: null as string | null,
  reads: [] as Array<[string, string | null]>,
  refresh: vi.fn(),
  openSectionItem: vi.fn(),
  requestWorkspaceHome: vi.fn(),
  nodes: {} as Record<string, { viewedAt?: number; lastAssistantAt?: number }>,
}));

vi.mock('../../../state/pages/useSpacesHome', () => ({
  useHomeConversations: (connectionId: string, state: string | null) => {
    mocks.reads.push([connectionId, state]);
    return { data: mocks.list, status: mocks.status, error: mocks.error, stale: false, refresh: mocks.refresh };
  },
}));
vi.mock('../spaces/home/useHomeNavigation', () => ({ useHomeNavigation: () => ({ openSectionItem: mocks.openSectionItem }) }));
vi.mock('../../../state/pages/workspaceHomeNav', () => ({ requestWorkspaceHome: mocks.requestWorkspaceHome }));
vi.mock('../../../state/chatStore', () => ({
  useOptionalChatProjects: () => ({ focusedNodeId: null }),
  useStructuralSelector: (select: (nodes: unknown) => unknown) => select(mocks.nodes),
}));

import { MichiThreads } from './MichiThreads';
import { getAllThreadsFilter, openAllThreadsFiltered, resetAllThreadsViewForTests } from '../../../state/content/allThreadsFilter';

const NOW = Date.now();
const item = (id: string, state: HomeSectionKey | null, extra: Partial<HomeConversationItem> = {}): HomeConversationItem => ({
  id: `conversation:${id}`, kind: 'conversation', workspaceId: 'ws-1', workspaceName: 'rabbitholes', title: `Chat ${id}`, at: NOW - 60_000,
  summary: state ? `About ${id}` : '', agentClaim: false, state, target: { kind: 'conversation', nodeId: id, workspaceId: 'ws-1', messageId: `${id}-m` }, ...extra,
});
const rows = () => screen.queryAllByTestId('spaces-home-row');
const titles = () => rows().map((row) => row.textContent?.match(/Chat \w+/)?.[0]);

beforeEach(() => {
  mocks.list = null;
  mocks.status = 'ready';
  mocks.error = null;
  mocks.reads = [];
  mocks.nodes = {};
  for (const fn of [mocks.refresh, mocks.openSectionItem, mocks.requestWorkspaceHome]) fn.mockReset();
});
afterEach(() => resetAllThreadsViewForTests());

describe('All threads from Spaces', () => {
  it('lists every Michi conversation of the local backend with its state and one action', () => {
    mocks.list = { items: [item('w', 'waiting'), item('s', 'stalled'), item('d', 'done'), item('q', null)], total: 4 };
    render(<MichiThreads state={null} />);
    expect(mocks.reads).toContainEqual(['local', null]);
    expect(screen.getByRole('heading', { level: 1, name: 'All threads' })).toBeTruthy();
    expect(screen.getByLabelText('4 threads')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'State filter' })).toBeNull();
    expect(titles()).toEqual(['Chat w', 'Chat s', 'Chat d', 'Chat q']);
    expect(rows().map((row) => row.querySelector('[data-state]')?.getAttribute('data-state') ?? null)).toEqual(['waiting', 'stalled', 'done', null]);
    expect(screen.getByRole('button', { name: 'Back to chat: Chat w' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue: Chat s' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View chat: Chat d' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat: Chat q' }));
    expect(mocks.openSectionItem).toHaveBeenCalledWith(mocks.list.items[3], null);
    fireEvent.click(within(rows()[0]!).getByRole('button', { name: 'rabbitholes' }));
    expect(mocks.requestWorkspaceHome).toHaveBeenCalledWith({ workspaceId: 'ws-1', backendConnectionId: 'local' });
  });

  it('opens on one state from View all, with a chip whose × lists every conversation again', () => {
    act(() => openAllThreadsFiltered('waiting'));
    mocks.list = { items: [item('w1', 'waiting'), item('w2', 'waiting')], total: 2 };
    render(<MichiThreads state="waiting" />);
    expect(mocks.reads).toContainEqual(['local', 'waiting']);
    const chip = screen.getByRole('group', { name: 'State filter' });
    expect(chip.textContent).toBe('Status is Waiting on you');
    fireEvent.click(within(chip).getByRole('button', { name: 'Remove filter Status is Waiting on you' }));
    expect(getAllThreadsFilter()).toBeNull();
  });

  it('drops a Just done conversation you opened since it finished, as the sidebar dot clears', () => {
    mocks.nodes = { seen: { viewedAt: NOW } };
    mocks.list = { items: [item('seen', 'done'), item('new', 'done')], total: 5 };
    const { rerender } = render(<MichiThreads state="done" />);
    expect(titles()).toEqual(['Chat new']);
    expect(screen.getByLabelText('4 threads')).toBeTruthy();
    expect(screen.getByText('Showing the 1 most recent of 4.')).toBeTruthy();

    mocks.list = { items: [item('seen', 'done'), item('q', null)], total: 2 };
    rerender(<MichiThreads state={null} />);
    expect(titles()).toEqual(['Chat seen', 'Chat q']);
    expect(rows()[0]!.querySelector('[data-state]')).toBeNull();
  });

  it('says when nothing is in the state, while it loads, and when the read failed', () => {
    mocks.list = { items: [], total: 0 };
    const { rerender } = render(<MichiThreads state="stalled" />);
    expect(screen.getByText('Nothing has stalled.')).toBeTruthy();
    mocks.list = null;
    mocks.status = 'loading';
    rerender(<MichiThreads state={null} />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    mocks.status = 'error';
    mocks.error = 'Backend unavailable';
    rerender(<MichiThreads state={null} />);
    expect(screen.getByRole('alert').textContent).toContain('Backend unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
});
