import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MichiDbEditOp, PageDatabase } from 'michi-shared';
import { toast } from 'sonner';
import { revertPageBatch } from '../../../services/api/pages';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import { usePageDatabase } from '../../../state/pages/usePageDatabase';
import type { DbEdit } from '../content/db/views/viewTypes';
import { NativeDatabase } from './NativeDatabase';

const captured = vi.hoisted(() => ({ edit: null as null | DbEdit }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('../../../services/api/pages', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../services/api/pages')>()), revertPageBatch: vi.fn() }));
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: vi.fn(), subscribePageChanges: vi.fn(() => () => {}) }));
vi.mock('../../../state/pages/usePageDatabase', () => ({ usePageDatabase: vi.fn() }));
vi.mock('./components/CustomDatabaseView', () => ({ CustomDatabaseView: () => null }));
vi.mock('../../../services/api/taskDatabase', () => ({ fetchTaskActivity: vi.fn(() => new Promise(() => {})), fetchTaskOrigin: vi.fn(() => new Promise(() => {})) }));
// The view itself is the board's business; here only the edits it makes matter.
vi.mock('../content/db/DatabaseView', () => ({ DatabaseView: ({ edit }: { edit: DbEdit }) => { captured.edit = edit; return null; } }));

const database: PageDatabase = {
  id: 'db-1', workspaceId: 'ws-1', title: 'Plan', revision: 4, updatedAt: 10,
  columns: [{ id: 'title', name: 'Title', type: 'text' }],
  views: [{ id: 'board', name: 'Board', type: 'board', position: 0, config: { filters: [], match: 'all', sorts: [] } }],
  rows: [{ id: 'row-1', values: { title: 'Task' }, position: 0, updatedAt: 9, rev: 3, edited: {}, bodyEditedAt: null }],
};
const written = { database, changes: { resource: { kind: 'database' as const, id: 'db-1' }, revision: 5, applied: [{ batchId: 'batch-7' }], proposed: [], rejected: [] } };
const ops: MichiDbEditOp[] = [{ op: 'row.update', id: 'row-1', values: { title: 'Task 2' } }];
const refresh = vi.fn();
const edit = vi.fn();
const show = () => render(<NativeDatabase databaseId="db-1" workspaceId="ws-1" connectionId="local" />);

beforeEach(() => {
  vi.mocked(toast).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(revertPageBatch).mockReset();
  vi.mocked(notifyPageChanged).mockReset();
  refresh.mockReset();
  edit.mockReset();
  vi.mocked(usePageDatabase).mockReturnValue({ database, status: 'ready', error: null, stale: false, refresh, edit });
});

describe('NativeDatabase undo', () => {
  it('offers Undo for a moved card and puts its batch back', async () => {
    edit.mockResolvedValue(written);
    vi.mocked(revertPageBatch).mockResolvedValue({ reverted: ['change-1'], conflicts: [] });
    show();
    await act(async () => { expect(await captured.edit!(ops, 'Changed Status', { undo: true })).toBe(true); });
    expect(edit).toHaveBeenCalledWith([{ ...ops[0], expectRev: 3 }]);
    expect(toast).toHaveBeenCalledWith('Changed Status', { action: { label: 'Undo', onClick: expect.any(Function) } });
    const { action } = vi.mocked(toast).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
    act(() => { action.onClick(); });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(revertPageBatch).toHaveBeenCalledWith('batch-7', { backendConnectionId: 'local', workspaceId: 'ws-1' });
    expect(notifyPageChanged).toHaveBeenCalledWith({ backendConnectionId: 'local', workspaceId: 'ws-1', databaseId: 'db-1' });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says so when the move changed again before Undo', async () => {
    edit.mockResolvedValue(written);
    vi.mocked(revertPageBatch).mockResolvedValue({ reverted: [], conflicts: [{ changeId: 'change-1', message: 'changed' }] });
    show();
    await act(async () => { await captured.edit!(ops, 'Changed Status', { undo: true }); });
    const { action } = vi.mocked(toast).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
    act(() => { action.onClick(); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not undone: it changed again since. Move it back yourself.'));
  });

  it('undoes a reorder by moving the card back, not by reverting its batch', async () => {
    edit.mockResolvedValue(written);
    show();
    const back: MichiDbEditOp[] = [{ op: 'row.move', id: 'row-1', after: null }];
    await act(async () => { await captured.edit!([{ op: 'row.move', id: 'row-1', after: 'row-2' }], 'Moved a card', { undo: true, undoOps: back }); });
    const { action } = vi.mocked(toast).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
    act(() => { action.onClick(); });
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(2));
    expect(edit).toHaveBeenLastCalledWith(back);
    expect(revertPageBatch).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1);
  });

  it('offers no Undo for other edits', async () => {
    edit.mockResolvedValue(written);
    show();
    await act(async () => { await captured.edit!(ops, 'Changed Title'); });
    expect(toast).not.toHaveBeenCalled();
  });

  it('says the database changed when a write meets a newer revision', async () => {
    edit.mockRejectedValue(Object.assign(new Error('Database revision changed'), { status: 409 }));
    show();
    await act(async () => { expect(await captured.edit!(ops, 'Changed Status', { undo: true })).toBe(false); });
    expect(screen.getByRole('alert').textContent).toBe('This database just changed, so it was refreshed. Try again.');
    expect(refresh).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('NativeDatabase undo of a reorder that cannot be applied', () => {
  it('says so and keeps no draft when the anchor row is gone', async () => {
    edit.mockResolvedValueOnce(written).mockRejectedValueOnce(new Error('row anchor missing'));
    show();
    const back: MichiDbEditOp[] = [{ op: 'row.move', id: 'row-1', after: 'row-9' }];
    await act(async () => { await captured.edit!([{ op: 'row.move', id: 'row-1', after: 'row-2' }], 'Moved a card', { undo: true, undoOps: back }); });
    const { action } = vi.mocked(toast).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
    act(() => { action.onClick(); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't undo the move."));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Retry/)).toBeNull();
  });
});
