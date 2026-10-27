import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AllTasksDto, MichiDbEditOp, PageDatabase } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews, TASK_VIEW } from 'michi-shared';
import { DatabaseView } from '../../content/db/DatabaseView';
import { allTasksBoard } from './allTasksDb';

const statuses = taskDatabaseColumns().find((column) => column.id === 'status')!.options!;
const row = (id: string, values: PageDatabase['rows'][number]['values']): PageDatabase['rows'][number] =>
  ({ id, values, position: 0, updatedAt: Date.now() - 60_000, rev: 1, edited: {}, bodyEditedAt: null });
const dto: AllTasksDto = {
  sources: [
    { workspaceId: 'ws-a', workspaceName: 'Alpha', databaseId: 'db-a', revision: 3, statuses },
    { workspaceId: 'ws-b', workspaceName: 'Beta', databaseId: 'db-b', revision: 7, statuses },
  ],
  rows: [
    { databaseId: 'db-a', row: row('r1', { task: 'Ship the release', status: 'todo' }) },
    { databaseId: 'db-b', row: row('r1', { task: 'Plan the launch', status: 'todo' }) },
  ],
  views: taskDatabaseViews(),
  viewsRevision: 1,
};

function Harness({ viewId }: { viewId: string }) {
  const [view, setView] = useState<string | null>(viewId);
  const edit = vi.fn(async (_ops: MichiDbEditOp[], _label: string) => true);
  return <DatabaseView db={allTasksBoard(dto)} edit={edit} viewId={view} onViewChange={setView} threadOf={() => undefined} now={Date.now()} services={{}} />;
}
const cardOf = (title: string) => screen.getByText(title).closest('.michi-card') as HTMLElement;

describe('All tasks in the database views', () => {
  it('names the workspace on each card, and offers no new task and no order of its own', () => {
    render(<Harness viewId={TASK_VIEW.board} />);
    expect(cardOf('Ship the release').querySelector('.michi-card__workspace')?.textContent).toBe('Alpha');
    expect(cardOf('Plan the launch').querySelector('.michi-card__workspace')?.textContent).toBe('Beta');
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^New task in/ })).toBeNull();
    // A card still moves to another status: that is the task's own.
    expect(cardOf('Ship the release').closest('.michi-db-slot')?.getAttribute('data-movable')).toBe('true');
  });

  it('keeps the rows and the columns of a table as they are', () => {
    render(<Harness viewId={TASK_VIEW.table} />);
    expect(screen.queryByRole('button', { name: '+ New row' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add column' })).toBeNull();
    fireEvent.click(within(screen.getByRole('columnheader', { name: /Status/ })).getByRole('button', { name: 'Status' }));
    const menu = screen.getByRole('menu', { name: 'Status column' });
    expect(within(menu).queryByRole('textbox', { name: 'Column name' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Delete column' })).toBeNull();
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);
  });
});
