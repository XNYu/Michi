import { describe, expect, it } from 'vitest';
import type { AllTasksDto, PageDatabase, ThreadCardItem } from 'michi-shared';
import { taskDatabaseColumns, taskDatabaseViews } from 'michi-shared';
import { allTasksBoard, allTasksRowId, conversationsInTaskWorkspaces, planAllTasksEdit, replaceSource, splitAllTasksRowId } from './allTasksDb';

const statuses = taskDatabaseColumns().find((column) => column.id === 'status')!.options!;
const row = (id: string, values: PageDatabase['rows'][number]['values'], updatedAt: number, rev = 1): PageDatabase['rows'][number] =>
  ({ id, values, position: 0, updatedAt, rev, edited: {}, bodyEditedAt: null });
const dto: AllTasksDto = {
  sources: [
    { workspaceId: 'ws-a', workspaceName: 'Alpha', databaseId: 'db-a', revision: 3, statuses },
    { workspaceId: 'ws-b', workspaceName: 'Beta', databaseId: 'db-b', revision: 7, statuses: [...statuses, { value: 'blocked', label: 'Blocked' }] },
  ],
  rows: [
    { databaseId: 'db-a', row: row('r1', { task: 'Ship the release', status: 'doing', threads: ['n1'], owner: 'Alex' }, 10, 2) },
    { databaseId: 'db-b', row: row('r1', { task: 'Plan the launch', status: 'blocked' }, 20, 4) },
  ],
  views: taskDatabaseViews(),
  viewsRevision: 2,
};
const card = (nodeId: string, workspaceId: string): ThreadCardItem => ({ nodeId, workspaceId, title: nodeId, state: 'done', summary: '', at: 1, messageId: null });

describe('All tasks as one database', () => {
  it('holds every task, newest change first, with its workspace and the core columns only', () => {
    const db = allTasksBoard(dto);
    expect([db.id, db.title, db.role, db.merged, db.updatedAt]).toEqual(['all-tasks', 'All tasks', 'tasks', true, 20]);
    expect(db.rows.map((item) => [item.id, item.position])).toEqual([['db-b/r1', 0], ['db-a/r1', 1]]);
    expect(db.rows[1]!.values).toEqual({ task: 'Ship the release', status: 'doing', threads: ['n1'], workspace: 'ws-a' });
    expect(db.columns.map((column) => [column.id, column.builtin, column.editable])).toEqual([
      ['task', true, true], ['status', true, true], ['threads', true, true], ['next', true, true], ['workspace', true, false],
    ]);
    expect(db.columns.find((column) => column.id === 'status')!.options!.map((option) => option.value)).toEqual(['todo', 'doing', 'waiting', 'done', 'blocked']);
    expect(db.views.map((view) => view.id)).toEqual(['tasks-board', 'tasks-table', 'tasks-needs-you']);
  });

  it('names a task by its database and its own id', () => {
    expect(allTasksRowId('db-a', 'r1')).toBe('db-a/r1');
    expect(splitAllTasksRowId('db-a/r1')).toEqual({ databaseId: 'db-a', rowId: 'r1' });
    expect(splitAllTasksRowId('db-a/r/1')).toEqual({ databaseId: 'db-a', rowId: 'r/1' });
    expect(splitAllTasksRowId('r1')).toBeNull();
    expect(splitAllTasksRowId('/r1')).toBeNull();
  });

  it("sends a change to each task's own database with its revision, and views to All tasks", () => {
    const save = { op: 'view.save' as const, view: { name: 'By workspace', type: 'board' as const, config: { filters: [], match: 'all' as const, sorts: [], group: 'workspace' } } };
    const plan = planAllTasksEdit(dto, [
      { op: 'row.update', id: 'db-a/r1', values: { status: 'done' } },
      { op: 'row.delete', id: 'db-b/r1' },
      save,
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect([...plan.rows]).toEqual([
      ['db-a', [{ op: 'row.update', id: 'r1', values: { status: 'done' }, expectRev: 2 }]],
      ['db-b', [{ op: 'row.delete', id: 'r1', expectRev: 4 }]],
    ]);
    expect(plan.views).toEqual([save]);
  });

  it('says why it takes no other change', () => {
    const refused = (op: Parameters<typeof planAllTasksEdit>[1][number]) => {
      const plan = planAllTasksEdit(dto, [op]);
      return plan.ok ? null : plan.reason;
    };
    expect(refused({ op: 'row.add', values: { task: 'x' } })).toBe("Add a task on its workspace's own board");
    expect(refused({ op: 'row.move', id: 'db-a/r1', after: null })).toBe("Put tasks in order on their workspace's own board");
    expect(refused({ op: 'column.update', id: 'status', patch: { name: 'Stage' } })).toBe("Change columns in a workspace's own Tasks database");
    expect(refused({ op: 'option.add', id: 'status', option: { value: 'later' } })).toBe("Change columns in a workspace's own Tasks database");
    expect(refused({ op: 'row.update', id: 'db-a/r1', values: { workspace: 'ws-b' } })).toBe('A task stays in its own workspace');
    expect(refused({ op: 'row.update', id: 'db-a/gone', values: { status: 'done' } })).toBe('This task changed. Refresh All tasks and try again.');
    expect(refused({ op: 'row.update', id: 'db-a/r1', values: { status: 'blocked' } })).toBe('Tasks in Alpha have no “Blocked” status');
    expect(refused({ op: 'view.save', view: { name: 'Mine', type: 'custom', config: { filters: [], match: 'all', sorts: [] } } })).toBe('All tasks has no custom views');
  });

  it("takes in one database's answer, and keeps a moved conversation out of the tasks it left", () => {
    const answered: PageDatabase = { id: 'db-a', workspaceId: 'ws-a', title: 'Tasks', role: 'tasks', revision: 4, updatedAt: 30,
      columns: taskDatabaseColumns(), views: taskDatabaseViews(), rows: [row('r1', { task: 'Ship the release', status: 'done' }, 30, 3)] };
    const next = replaceSource(dto, answered);
    expect(next.sources.map((source) => source.revision)).toEqual([4, 7]);
    expect(next.rows.map((entry) => [entry.databaseId, entry.row.values.status])).toEqual([['db-b', 'blocked'], ['db-a', 'done']]);
    expect(replaceSource(dto, { ...answered, id: 'db-x' })).toBe(dto);

    const linked: AllTasksDto = { ...dto, rows: [...dto.rows, { databaseId: 'db-b', row: row('r2', { task: 'Book', threads: ['n2', 'n3'] }, 5) }] };
    const kept = conversationsInTaskWorkspaces(linked, new Map([['n1', card('n1', 'ws-a')], ['n2', card('n2', 'ws-a')], ['n4', card('n4', 'ws-b')]]));
    expect([...kept.keys()]).toEqual(['n1']);
  });
});
