import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageChangeDto, PageDatabase, TaskActivity } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { toast } from 'sonner';
import { changePageChange, revertPageBatch } from '../../../services/api/pages';
import { fetchThreadStates } from '../../../services/api/spacesHome';
import { fetchTaskActivity, fetchTaskOrigin } from '../../../services/api/taskDatabase';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import { usePageDatabase } from '../../../state/pages/usePageDatabase';
import { NativeDatabase } from './NativeDatabase';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('../../../services/api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/api/pages')>()), revertPageBatch: vi.fn(), changePageChange: vi.fn(),
}));
vi.mock('../../../services/api/spacesHome', () => ({ fetchThreadStates: vi.fn(), fetchHomeConversations: vi.fn() }));
vi.mock('../../../services/api/taskDatabase', () => ({ fetchTaskActivity: vi.fn(), fetchTaskOrigin: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn(), subscribePageChanges: vi.fn(() => () => {}) }));
vi.mock('../../../state/pages/usePageDatabase', () => ({ usePageDatabase: vi.fn() }));
vi.mock('./components/CustomDatabaseView', () => ({ CustomDatabaseView: () => null }));

const AGO = Date.now() - 60_000;
const row = (id: string, values: PageDatabase['rows'][number]['values'], position: number, edited: Record<string, number> = {}) =>
  ({ id, values, position, updatedAt: AGO, rev: 2, edited, bodyEditedAt: null });
const database: PageDatabase = {
  id: 'db-tasks', workspaceId: 'ws-1', title: 'Tasks', role: 'tasks', revision: 5, updatedAt: AGO,
  columns: taskDatabaseColumns(), views: taskDatabaseViews(),
  rows: [
    row('ship', { task: 'Ship the release', status: 'done' }, 0),
    row('notes', { task: 'Write the release notes', status: 'todo' }, 1),
    row('docs', { task: 'Review the docs', status: 'doing' }, 2, { status: 1 }),
  ],
};
const suggestion: PageChangeDto = {
  id: 'chg-docs', seq: 9, batchId: 'batch-upkeep', target: { kind: 'row', databaseId: 'db-tasks', rowId: 'docs', columnIds: ['status'] }, op: 'row',
  before: null, after: null,
  forward: { kind: 'row', op: 'patch', id: 'docs', values: { status: 'waiting' } },
  inverse: { kind: 'row', op: 'patch', id: 'docs', values: { status: 'doing' } },
  baseRev: 2, appliedRev: null, previousHeadId: null,
  source: { kind: 'maintenance', nodeId: 'run', turnId: 'run-turn', assistantId: 'run-a', jobId: 'job', runId: 'run-1', evidence: [{ nodeId: 'n1', turnId: 't1', assistantId: 'a1' }] },
  proposalState: 'pending', applicationState: null, createdAt: AGO, resolvedAt: null,
};
const upkept: TaskActivity = {
  suggestions: [suggestion],
  marks: [{ rowId: 'notes', kind: 'new', at: AGO }, { rowId: 'ship', kind: 'updated', at: AGO }],
  latestUpkeep: { batchId: 'batch-upkeep', at: AGO, added: 1, updated: 1, removed: 0, suggested: 1,
    source: { nodeId: 'n1', turnId: 't1', assistantId: 'a1', title: 'Release check' } },
};
const refresh = vi.fn();
const show = () => render(<NativeDatabase databaseId="db-tasks" workspaceId="ws-1" connectionId="local" viewId="tasks-board" presentation="page" />);
const cardOf = (title: string) => screen.getAllByText(title).map((node) => node.closest('.michi-card')).find(Boolean) as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(toast).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(revertPageBatch).mockReset();
  vi.mocked(changePageChange).mockReset().mockResolvedValue(suggestion);
  vi.mocked(notifyPageChanged).mockReset();
  vi.mocked(fetchThreadStates).mockReset().mockResolvedValue([]);
  vi.mocked(fetchTaskActivity).mockReset().mockResolvedValue(upkept);
  vi.mocked(fetchTaskOrigin).mockReset().mockResolvedValue({ by: 'meta-agent', conversations: 1, at: AGO });
  refresh.mockReset();
  vi.mocked(usePageDatabase).mockReturnValue({ database, status: 'ready', error: null, stale: false, refresh, edit: vi.fn() });
});

describe('a task board with the Meta agent’s upkeep', () => {
  it('notes the latest update above the board, marks its tasks, and undoes it', async () => {
    vi.mocked(revertPageBatch).mockResolvedValue({ reverted: ['c1', 'c2'], conflicts: [] });
    show();
    const note = (await screen.findAllByText('Meta agent added 1 task, updated 1 and suggested 1 change'))[0];
    const line = note.closest('.michi-task-upkeep') as HTMLElement;
    expect(line.textContent).toContain('from “Release check”');
    expect(cardOf('Write the release notes').querySelector('[data-mark="new"]')).not.toBeNull();
    expect(cardOf('Ship the release').querySelector('[data-mark="updated"]')).not.toBeNull();
    expect(cardOf('Review the docs').querySelector('[data-mark="suggestion"]')).not.toBeNull();
    fireEvent.click(within(line).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Undid the Meta agent's update"));
    expect(revertPageBatch).toHaveBeenCalledWith('batch-upkeep', { backendConnectionId: 'local', workspaceId: 'ws-1' });
    expect(refresh).toHaveBeenCalled();
    expect(notifyPageChanged).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-1', databaseId: 'db-tasks' });
    await waitFor(() => expect(fetchTaskActivity).toHaveBeenCalledTimes(2));
  });

  it('says so when part of the update changed again before Undo', async () => {
    vi.mocked(revertPageBatch).mockResolvedValue({ reverted: ['c1'], conflicts: [{ changeId: 'c2', message: 'changed' }] });
    show();
    const line = (await screen.findAllByText(/^Meta agent added/))[0].closest('.michi-task-upkeep') as HTMLElement;
    fireEvent.click(within(line).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not all of it was undone: some tasks changed again since.'));
  });

  it("accepts a suggestion from the task's details, and an opened task loses its mark", async () => {
    show();
    await screen.findAllByText(/^Meta agent added/);
    fireEvent.click(screen.getByText('Review the docs'));
    const drawer = screen.getByRole('dialog', { name: 'Task' });
    expect(within(drawer).getByText('Suggested: Status → Waiting on you')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(changePageChange).toHaveBeenCalledWith('chg-docs', 'accept', { backendConnectionId: 'local', workspaceId: 'ws-1' }, undefined));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(drawer.querySelector('.michi-db-peek__origin')?.textContent).toBe('Created by Meta agent from 1 conversation · 1m ago'));
    expect(fetchTaskOrigin).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-1', databaseId: 'db-tasks', rowId: 'docs' });

    fireEvent.click(cardOf('Ship the release').querySelector('.michi-card__title')!);
    await waitFor(() => expect(cardOf('Ship the release').querySelector('[data-mark="updated"]')).toBeNull());
  });

  it('offers no Undo for an update that only suggested', async () => {
    vi.mocked(fetchTaskActivity).mockResolvedValue({ ...upkept, marks: [],
      latestUpkeep: { ...upkept.latestUpkeep!, added: 0, updated: 0, suggested: 2 } });
    show();
    const line = (await screen.findAllByText('Meta agent suggested 2 changes'))[0].closest('.michi-task-upkeep') as HTMLElement;
    expect(within(line).queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
