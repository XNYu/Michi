import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DeskNow, DeskThread } from 'michi-shared';
import type { Project } from '../../../../state/chatTypes';
import DeskNowPage from './DeskNowPage';
import { setDeskUndo } from './DeskChrome';
import { getDeskNow, postDeskMutation } from '../../../../services/api/desk';

const actions = {
  selectProject: vi.fn(),
  activateTree: vi.fn(),
  openPane: vi.fn(),
  openPaneInTree: vi.fn(),
  setFocusedNodeId: vi.fn(),
};

const projects = [
  {
    id: 'ws',
    name: 'Michi',
    createdAt: 0,
    activeTreeId: 'other',
    chatIds: ['root'],
    edges: [],
    trees: [{ id: 'tree', rootNodeId: 'root', createdAt: 0, lastActiveAt: 1 }],
  },
] as Project[];

vi.mock('../../../../state/chatStore', () => ({
  useChatStore: () => ({
    projects,
    activeProjectId: 'ws',
    ...actions,
  }),
}));

vi.mock('../../../../services/api/desk', () => ({
  getDeskNow: vi.fn(),
  markDeskLooked: vi.fn().mockResolvedValue({ ok: true }),
  postDeskMutation: vi.fn().mockResolvedValue({ receipt: { id: 'r1', action: 'archive' } }),
  undoDeskReceipt: vi.fn().mockResolvedValue({ ok: true }),
}));

function thread(overrides: Partial<DeskThread> & Pick<DeskThread, 'id' | 'state' | 'title'>): DeskThread {
  return {
    projectId: 'ws',
    projectTitle: 'Michi',
    rootNodeId: 'root',
    focusNodeId: 'root',
    lastActivityAt: Date.now() - 60 * 60 * 1000,
    idleDays: 0,
    stoppedAt: 'Stopped here',
    next: null,
    source: null,
    ...overrides,
  };
}

const now: DeskNow = {
  since: 0,
  summary: '1 waiting on you. 1 line stalled for 4 days.',
  agenda: [],
  waiting: [thread({ id: 'tree', state: 'waiting', title: 'Schema decision', next: 'Pick camelCase' })],
  stalled: [thread({ id: 'quiet', state: 'stalled', title: 'Old migration', idleDays: 4, focusNodeId: 'quiet-root', rootNodeId: 'quiet-root' })],
  done: [],
  more: { waiting: 0, stalled: 0, done: 0 },
  archived: [],
  archivedCount: 2,
};

describe('DeskNowPage', () => {
  beforeEach(() => {
    setDeskUndo(null);
    for (const fn of Object.values(actions)) fn.mockClear();
    vi.mocked(getDeskNow).mockResolvedValue(now);
    vi.mocked(postDeskMutation).mockClear();
  });

  it('shows the three-section summary and opens a Michi thread', async () => {
    const onNav = vi.fn();
    render(<DeskNowPage onNav={onNav} />);
    expect(await screen.findByText('1 waiting on you. 1 line stalled for 4 days.')).toBeTruthy();
    expect(screen.getByText('Waiting on you')).toBeTruthy();
    expect(screen.getByText('Stalled')).toBeTruthy();
    expect(screen.getByText('Archived · 2')).toBeTruthy();

    const row = screen.getAllByTestId('desk-thread')[0];
    fireEvent.click(within(row).getByRole('button', { name: 'Continue' }));
    expect(actions.openPaneInTree).toHaveBeenCalledWith('ws', 'tree', 'root');
    expect(actions.activateTree).toHaveBeenCalledWith('tree', 'ws');
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it('archives a thread and offers undo', async () => {
    render(<DeskNowPage onNav={vi.fn()} />);
    const row = (await screen.findAllByTestId('desk-thread'))[0];
    fireEvent.click(within(row).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(postDeskMutation).toHaveBeenCalledWith('archive', ['tree']));
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });
});
