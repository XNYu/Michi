import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllTasksDto, PageDatabase } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { editPageDatabase, revertPageBatch } from '../../../../services/api/pages';
import { fetchAllTasks } from '../../../../services/api/taskDatabase';
import AllTasksPage from './AllTasksPage';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('../../../../services/api/pages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/pages')>()), editPageDatabase: vi.fn(), revertPageBatch: vi.fn(),
}));
vi.mock('../../../../services/api/spacesHome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/spacesHome')>()), fetchThreadStates: vi.fn(async () => []), fetchHomeConversations: vi.fn(),
}));
vi.mock('../../../../services/api/taskDatabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/api/taskDatabase')>()), fetchAllTasks: vi.fn(), fetchTaskOrigin: vi.fn(), saveAllTasksViews: vi.fn(),
}));
vi.mock('../../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn(), subscribePageChanges: vi.fn(() => () => {}) }));
vi.mock('../../../../state/sourceNav/sourceNav', () => ({ openConversationFromSpaces: vi.fn(async () => true) }));
// The board's own drag is not under test: a button writes a change the way a drop does.
vi.mock('../../content/db/DatabaseView', () => ({
  DatabaseView: ({ edit }: { edit: (ops: unknown[], label: string, options?: { undo?: boolean }) => Promise<boolean> }) => (
    <button type="button" onClick={() => { void edit([{ op: 'row.update', id: 'db-a/r1', values: { status: 'done' } }], 'Moved a card', { undo: true }); }}>Drop</button>
  ),
}));

const statuses = taskDatabaseColumns().find((column) => column.id === 'status')!.options!;
const dto: AllTasksDto = {
  sources: [{ workspaceId: 'ws-a', workspaceName: 'Alpha', databaseId: 'db-a', revision: 3, statuses }],
  rows: [{ databaseId: 'db-a', row: { id: 'r1', values: { task: 'Ship', status: 'todo' }, position: 0, updatedAt: 1, rev: 1, edited: {}, bodyEditedAt: null } }],
  views: taskDatabaseViews(),
  viewsRevision: 1,
};
const after: PageDatabase = {
  id: 'db-a', workspaceId: 'ws-a', title: 'Tasks', role: 'tasks', revision: 4, updatedAt: 2,
  columns: taskDatabaseColumns(), views: taskDatabaseViews(), rows: [{ id: 'r1', values: { task: 'Ship', status: 'done' }, position: 0, updatedAt: 2, rev: 2, edited: {}, bodyEditedAt: null }],
};

beforeEach(() => {
  vi.mocked(fetchAllTasks).mockReset().mockResolvedValue(dto);
  vi.mocked(editPageDatabase).mockReset().mockResolvedValue({ database: after, changes: { applied: [{ batchId: 'b-1' }] } } as never);
  vi.mocked(revertPageBatch).mockReset();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

async function dropAndUndo() {
  render(<AllTasksPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Drop' }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  const options = vi.mocked(toast).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
  act(() => options.action.onClick());
}

describe('Undo on All tasks', () => {
  it('says when only part of it went back', async () => {
    vi.mocked(revertPageBatch).mockResolvedValue({ reverted: ['c1'], conflicts: ['c2'] } as never);
    await dropAndUndo();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not all of it was undone: some of it changed again since.'));
  });

  it('says when none of it went back', async () => {
    vi.mocked(revertPageBatch).mockResolvedValue({ reverted: [], conflicts: ['c2'] } as never);
    await dropAndUndo();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not undone: it changed again since. Change it back yourself.'));
  });
});
