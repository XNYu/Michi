import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllTasksDto, PageDatabase } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { editPageDatabase } from '../../../../services/api/pages';
import { fetchThreadStates } from '../../../../services/api/spacesHome';
import { fetchAllTasks, fetchTaskOrigin, saveAllTasksViews } from '../../../../services/api/taskDatabase';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import AllTasksPage from './AllTasksPage';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('../../../../services/api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/pages')>()), editPageDatabase: vi.fn(), revertPageBatch: vi.fn(),
}));
vi.mock('../../../../services/api/spacesHome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/spacesHome')>()), fetchThreadStates: vi.fn(), fetchHomeConversations: vi.fn(),
}));
vi.mock('../../../../services/api/taskDatabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/taskDatabase')>()), fetchAllTasks: vi.fn(), fetchTaskOrigin: vi.fn(), saveAllTasksViews: vi.fn(),
}));
vi.mock('../../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn(), subscribePageChanges: vi.fn(() => () => {}) }));
vi.mock('../../../../state/sourceNav/sourceNav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/sourceNav/sourceNav')>()), openConversationFromSpaces: vi.fn(async () => true),
}));

const statuses = taskDatabaseColumns().find((column) => column.id === 'status')!.options!;
const AGO = Date.now() - 60_000;
const row = (id: string, values: PageDatabase['rows'][number]['values'], rev = 1): PageDatabase['rows'][number] =>
  ({ id, values, position: 0, updatedAt: AGO, rev, edited: {}, bodyEditedAt: null });
const allTasks = (): AllTasksDto => ({
  sources: [
    { workspaceId: 'ws-a', workspaceName: 'Alpha', databaseId: 'db-a', revision: 3, statuses },
    { workspaceId: 'ws-b', workspaceName: 'Beta', databaseId: 'db-b', revision: 7, statuses },
  ],
  rows: [
    { databaseId: 'db-a', row: row('r1', { task: 'Ship the release', status: 'todo' }, 2) },
    { databaseId: 'db-b', row: row('r1', { task: 'Plan the launch', status: 'doing' }) },
  ],
  views: taskDatabaseViews(),
  viewsRevision: 2,
});
const alphaAfter: PageDatabase = {
  id: 'db-a', workspaceId: 'ws-a', title: 'Tasks', role: 'tasks', revision: 4, updatedAt: Date.now(),
  columns: taskDatabaseColumns(), views: taskDatabaseViews(), rows: [row('r1', { task: 'Ship the release', status: 'done' }, 3)],
};
const cardOf = (title: string) => screen.getAllByText(title).map((node) => node.closest('.michi-card')).find(Boolean) as HTMLElement;
const setStatus = async (title: string, status: string) => {
  fireEvent.click(await screen.findByText(title));
  const drawer = screen.getByRole('dialog', { name: 'Task' });
  fireEvent.click(within(drawer).getByRole('button', { name: 'Edit Status' }));
  fireEvent.click(screen.getByRole('option', { name: status }));
  return drawer;
};

beforeEach(() => {
  vi.mocked(fetchAllTasks).mockReset().mockResolvedValue(allTasks());
  vi.mocked(fetchThreadStates).mockReset().mockResolvedValue([]);
  vi.mocked(fetchTaskOrigin).mockReset().mockResolvedValue({ by: 'you', conversations: 0, at: AGO });
  vi.mocked(saveAllTasksViews).mockReset();
  vi.mocked(editPageDatabase).mockReset().mockResolvedValue({ database: alphaAfter, changes: { applied: [{ batchId: 'b-1' }] } } as never);
  vi.mocked(notifyPageChanged).mockReset();
});

describe('All tasks', () => {
  it("shows every workspace's tasks, and writes a change to the task's own database", async () => {
    render(<AllTasksPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'All tasks' })).toBeTruthy();
    expect(await screen.findByText('2 tasks')).toBeTruthy();
    expect(cardOf('Ship the release').querySelector('.michi-card__workspace')?.textContent).toBe('Alpha');
    expect(cardOf('Plan the launch').querySelector('.michi-card__workspace')?.textContent).toBe('Beta');

    const drawer = await setStatus('Ship the release', 'Done');
    await waitFor(() => expect(editPageDatabase).toHaveBeenCalledWith(
      'db-a',
      { revision: 3, ops: [{ op: 'row.update', id: 'r1', values: { status: 'done' }, expectRev: 2 }] },
      { backendConnectionId: 'local', workspaceId: 'ws-a' },
    ));
    await waitFor(() => expect(notifyPageChanged).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-a', databaseId: 'db-a' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Ship the release')).toBeTruthy());
    await waitFor(() => expect(drawer.querySelector('.michi-db-peek__origin')?.textContent).toBe('Created by you · 1m ago'));
    expect(fetchTaskOrigin).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-a', databaseId: 'db-a', rowId: 'r1' });
  });

  it('says a task changed meanwhile, and reads every task again', async () => {
    vi.mocked(editPageDatabase).mockRejectedValueOnce(Object.assign(new Error('Database revision changed'), { status: 409 }));
    render(<AllTasksPage />);
    await setStatus('Ship the release', 'Done');
    expect(await screen.findByText('All tasks just changed, so it was refreshed. Try again.')).toBeTruthy();
    await waitFor(() => expect(fetchAllTasks).toHaveBeenCalledTimes(2));
  });

  it('keeps views of its own, and no custom view', async () => {
    vi.mocked(saveAllTasksViews).mockResolvedValue({ views: taskDatabaseViews(), viewsRevision: 3 });
    render(<AllTasksPage />);
    await screen.findByText('Ship the release');
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    expect(screen.queryByRole('menuitem', { name: /Custom/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Table' }));
    await waitFor(() => expect(saveAllTasksViews).toHaveBeenCalledWith({
      revision: 2,
      ops: [expect.objectContaining({ op: 'view.save', view: expect.objectContaining({ name: 'Table 2', type: 'table' }) })],
    }));
    expect(editPageDatabase).not.toHaveBeenCalled();
  });

  it('says one task in the singular', async () => {
    vi.mocked(fetchAllTasks).mockResolvedValue({ ...allTasks(), rows: allTasks().rows.slice(0, 1) });
    render(<AllTasksPage />);
    expect(await screen.findByText('1 task')).toBeTruthy();
  });

  it('does not let a read that started before a view save bring the old views back', async () => {
    vi.mocked(saveAllTasksViews).mockResolvedValue({ views: taskDatabaseViews(), viewsRevision: 3 });
    render(<AllTasksPage />);
    await screen.findByText('Ship the release');
    let finishRead: (dto: AllTasksDto) => void = () => {};
    vi.mocked(fetchAllTasks).mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Table' }));
    await waitFor(() => expect(saveAllTasksViews).toHaveBeenCalledTimes(1));
    // The read is old for views (revision 2) but its rows are the freshest.
    await act(async () => { finishRead({ ...allTasks(), rows: [...allTasks().rows, { databaseId: 'db-b', row: row('r9', { task: 'Fresh task', status: 'todo' }) }] }); });
    expect(await screen.findByText('Fresh task')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Table' }));
    await waitFor(() => expect(saveAllTasksViews).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveAllTasksViews).mock.calls[1][0].revision).toBe(3);
  });

  it('saves views one at a time, the second on the revision the first answered', async () => {
    let finishFirst: (value: { views: ReturnType<typeof taskDatabaseViews>; viewsRevision: number }) => void = () => {};
    vi.mocked(saveAllTasksViews)
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ views: taskDatabaseViews(), viewsRevision: 4 });
    render(<AllTasksPage />);
    await screen.findByText('Ship the release');
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Add view' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Table' }));
    }
    await waitFor(() => expect(saveAllTasksViews).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveAllTasksViews).mock.calls[0][0].revision).toBe(2);
    await act(async () => { finishFirst({ views: taskDatabaseViews(), viewsRevision: 3 }); });
    await waitFor(() => expect(saveAllTasksViews).toHaveBeenCalledTimes(2));
    expect(vi.mocked(saveAllTasksViews).mock.calls[1][0].revision).toBe(3);
  });
});
