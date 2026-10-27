import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPageDatabaseOps, type PageDatabase } from '../../shared/src/pages/database';
import {
  containsTaskView, conversationWaitsOnYou, databaseRoleProblem, isTaskCoreColumn, isTaskDb,
  taskDatabaseColumns, taskDatabaseViews, taskThreadIds, TASK_VIEW,
} from '../../shared/src/pages/tasks';
import { isTargetMutation } from '../../shared/src/pages/types';

const tasks = (): PageDatabase => ({ id: 'db-tasks', workspaceId: 'ws', title: 'Tasks', role: 'tasks', revision: 1, updatedAt: 1,
  columns: taskDatabaseColumns(), views: taskDatabaseViews(), rows: [] });

test('a new task database has its four core columns and three views, and passes the database checks', () => {
  const db = tasks();
  assert.deepEqual(db.columns.map((c) => [c.id, c.type]), [['task', 'text'], ['status', 'select'], ['threads', 'threads'], ['next', 'text']]);
  assert.deepEqual(db.columns.find((c) => c.id === 'status')?.options?.map((o) => [o.value, o.label]),
    [['todo', 'To do'], ['doing', 'In progress'], ['waiting', 'Waiting on you'], ['done', 'Done']]);
  assert.deepEqual(db.views.map((v) => [v.id, v.type, v.name]), [[TASK_VIEW.board, 'board', 'Board'], [TASK_VIEW.table, 'table', 'Table'], [TASK_VIEW.needsYou, 'list', 'Needs you']]);
  assert.deepEqual(db.views[2]!.config, { filters: [{ column: 'status', op: 'is', value: 'waiting' }, { column: 'threads', op: 'waiting' }], match: 'any', sorts: [] });
  assert.equal(databaseRoleProblem(db, 'tasks'), null);
  assert.doesNotThrow(() => applyPageDatabaseOps(db, [], { actor: 'user', revision: 2, now: 2 }));
  assert.ok(isTargetMutation({ kind: 'database', op: 'replace', database: { id: db.id, workspaceId: db.workspaceId, title: db.title, columns: db.columns, views: db.views } }));
  assert.equal(isTaskDb(db), true);
  assert.equal(isTaskDb({ ...db, role: undefined }), false);
});

test('the core columns keep their ids and types, and the four statuses stay', () => {
  const db = tasks();
  const columns = db.columns;
  assert.match(databaseRoleProblem({ columns: columns.filter((c) => c.id !== 'status') }, 'tasks')!, /keeps its Status column/);
  assert.match(databaseRoleProblem({ columns: columns.map((c) => (c.id === 'next' ? { ...c, type: 'url' as const } : c)) }, 'tasks')!, /Next step column of a task database keeps its type/);
  assert.match(databaseRoleProblem({ columns: columns.map((c) => (c.id === 'status' ? { ...c, options: c.options!.filter((o) => o.value !== 'waiting') } : c)) }, 'tasks')!, /Waiting on you/);
  assert.equal(databaseRoleProblem({ columns: columns.map((c) => (c.id === 'status' ? { ...c, name: 'Stage', options: [...c.options!, { value: 'blocked' }] } : c)) }, 'tasks'), null,
    'renaming a core column or adding a status is fine');
  assert.match(databaseRoleProblem({ columns: [...columns, { id: 'more', name: 'More', type: 'threads' }] }, 'tasks')!, /one Conversations column/);
  assert.match(databaseRoleProblem({ columns: [{ id: 'c', name: 'Chats', type: 'threads' }] }, null)!, /Only a task database/);
  assert.equal(databaseRoleProblem({ columns: [{ id: 'c', name: 'Name', type: 'text' }] }, null), null);
  assert.equal(isTaskCoreColumn({ role: 'tasks' }, { id: 'status' }), true);
  assert.equal(isTaskCoreColumn({ role: 'tasks' }, { id: 'owner' }), false);
  assert.equal(isTaskCoreColumn({}, { id: 'status' }), false);
});

test('a page shows the task board wherever it sits, and a linked conversation waits only while it waits', () => {
  assert.equal(containsTaskView([{ id: 'b', rev: 1, type: 'markdown', text: 'x' }]), false);
  assert.equal(containsTaskView([{ type: 'grid', regions: [{ id: 'side', span: 4, blocks: [{ type: 'toggle', title: 'More', blocks: [{ type: 'task-view' }] }] }] }]), true);
  assert.equal(containsTaskView([{ type: 'tabs', tabs: [{ label: 'A', blocks: [] }, { label: 'B', blocks: [{ type: 'task-view', viewId: TASK_VIEW.table }] }] }]), true);
  assert.equal(containsTaskView([{ type: 'columns', columns: [[{ type: 'heading', text: 'x' }], [{ type: 'task-view' }]] }]), true);
  assert.deepEqual(taskThreadIds(['n1', '', 'n2']), ['n1', 'n2']);
  assert.deepEqual(taskThreadIds('n1'), []);
  assert.deepEqual(taskThreadIds(undefined), []);
  assert.equal(conversationWaitsOnYou('waiting'), true);
  assert.equal(conversationWaitsOnYou('stalled'), false);
  assert.equal(conversationWaitsOnYou(undefined), false);
});
