import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPageDatabaseOps, parsePageDatabaseOps, type PageDatabase } from '../../shared/src/pages/database';
import { effectiveConfig } from '../../shared/src/database/viewModel';
import { isTargetMutation } from '../../shared/src/pages/types';

const db: PageDatabase = {
  id: 'db1', workspaceId: 'ws1', title: 'Release', revision: 1, updatedAt: 10,
  columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'status', name: 'Status', type: 'select', options: [{ value: 'todo' }] }],
  views: [{ id: 'table', name: 'Table', type: 'table', config: { filters: [], match: 'all', sorts: [] }, position: 0 }],
  rows: [{ id: 'r1', values: { name: 'Build', status: 'todo' }, position: 0, updatedAt: 10, rev: 1, edited: {}, bodyEditedAt: null }],
};

test('native database parser bounds payload and rejects server metadata and agent schema edits', () => {
  assert.equal(parsePageDatabaseOps([{ op: 'row.update', id: 'r1', values: { name: 'Ship' }, expectRev: 1, rev: 2 }], 'user').ok, false);
  assert.equal(parsePageDatabaseOps([{ op: 'column.delete', id: 'name' }], 'agent').ok, false);
  assert.equal(parsePageDatabaseOps([{ op: 'row.update', id: 'r1', values: { name: 'Ship' } }], 'agent').ok, false);
  assert.equal(parsePageDatabaseOps(Array(201).fill({ op: 'row.delete', id: 'r1' }), 'user').ok, false);
  assert.equal(parsePageDatabaseOps([{ op: 'row.update', id: 'r1', values: { name: 'Ship' }, expectRev: 1 }], 'agent').ok, true);
});

test('user row edits stamp cell and body ownership; stale agent CAS leaves the row untouched', () => {
  const user = applyPageDatabaseOps(db, [{ op: 'row.update', id: 'r1', values: { name: 'Ship' }, body: '# Plan' }], { actor: 'user', revision: 2, now: 20 });
  assert.equal(user.database.rows[0]?.rev, 2);
  assert.equal(user.database.rows[0]?.edited.name, 20);
  assert.equal(user.database.rows[0]?.bodyEditedAt, 20);
  const agent = applyPageDatabaseOps(user.database, [{ op: 'row.update', id: 'r1', values: { name: 'Done' }, expectRev: 1 }], { actor: 'agent', revision: 3, now: 30 });
  assert.equal(agent.database.rows[0]?.values.name, 'Ship');
  assert.deepEqual(agent.touchedRows, []);
});

test('same-value row updates are no-ops unless they establish human ownership', () => {
  const owned: PageDatabase = {
    ...db,
    rows: [{ ...db.rows[0]!, edited: { name: 10 }, body: '# Plan', bodyEditedAt: 10 }],
  };
  const unchanged = applyPageDatabaseOps(owned, [{ op: 'row.update', id: 'r1', values: { name: 'Build' }, body: '# Plan' }], {
    actor: 'user', revision: 2, now: 20,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.database, owned);
  assert.deepEqual(unchanged.touchedRows, []);
  assert.equal(unchanged.database.rows[0]?.rev, 1);
  assert.equal(unchanged.database.rows[0]?.updatedAt, 10);
  assert.equal(unchanged.database.rows[0]?.edited.name, 10);
  assert.equal(unchanged.database.rows[0]?.bodyEditedAt, 10);

  const agentNoop = applyPageDatabaseOps(owned, [{ op: 'row.update', id: 'r1', values: { name: 'Build' }, expectRev: 1 }], {
    actor: 'agent', revision: 2, now: 20,
  });
  assert.equal(agentNoop.changed, false);
  assert.equal(agentNoop.database, owned);

  // Writing the same displayed value still protects it if the cell was not
  // previously human-owned. Body ownership follows the same rule.
  const firstHumanSave = applyPageDatabaseOps(db, [{ op: 'row.update', id: 'r1', values: { status: 'todo' }, body: '' }], {
    actor: 'user', revision: 2, now: 20,
  });
  assert.equal(firstHumanSave.changed, true);
  assert.equal(firstHumanSave.database.rows[0]?.rev, 2);
  assert.equal(firstHumanSave.database.rows[0]?.edited.status, 20);
  assert.equal(firstHumanSave.database.rows[0]?.bodyEditedAt, 20);
  assert.deepEqual(firstHumanSave.touchedRows, ['r1']);
});

test('row creation gets a stable supplied id and initial row metadata', () => {
  const parsed = parsePageDatabaseOps([{ op: 'row.add', values: { name: 'Plan' }, body: '' }], 'user');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const result = applyPageDatabaseOps(db, parsed.ops, { actor: 'user', revision: 2, now: 25, newId: () => 'r2' });
  const row = result.database.rows.find((item) => item.id === 'r2');
  assert.equal(row?.rev, 2);
  assert.equal(row?.bodyEditedAt, 25);
  assert.deepEqual(result.touchedRows, ['r2']);
});

test('schema and view validators reject unbounded or unsupported definitions', () => {
  assert.equal(parsePageDatabaseOps([{ op: 'view.save', view: { name: 'Custom', type: 'table', config: { filters: [{ surprise: true }], match: 'all', sorts: [] } } }], 'user').ok, false);
  assert.equal(parsePageDatabaseOps([{ op: 'view.save', view: { name: 'Custom', type: 'table', config: { filters: [], match: 'all', sorts: [], code: 'return 1' } } }], 'user').ok, false);
  assert.equal(parsePageDatabaseOps([{ op: 'column.add', column: { id: 'status', name: 'Duplicate', type: 'text' } }], 'user').ok, true);
  assert.equal(parsePageDatabaseOps([{ op: 'row.move', id: 'r1' }], 'user').ok, false);
  assert.equal(parsePageDatabaseOps([{ op: 'row.add', id: 'r1', values: {} }, { op: 'row.add', id: 'r1', values: {} }], 'user').ok, false);
});

test('every Michi view type saves on a native database and stays valid in its history', () => {
  const dated: PageDatabase = { ...db, columns: [...db.columns, { id: 'due', name: 'Due', type: 'date' }, { id: 'photo', name: 'Photo', type: 'image' }] };
  for (const type of ['list', 'calendar', 'gallery', 'timeline'] as const) {
    const parsed = parsePageDatabaseOps([{ op: 'view.save', view: { id: type, name: type, type, config: { filters: [], match: 'all', sorts: [], date: 'due', planDate: 'due', cover: 'photo' } } }], 'user');
    assert.equal(parsed.ok, true, type);
    if (!parsed.ok) continue;
    const saved = applyPageDatabaseOps(dated, parsed.ops, { actor: 'user', revision: 2, now: 20 }).database;
    assert.equal(saved.views.find((view) => view.id === type)?.type, type);
    const { id, workspaceId, title, columns, views } = saved;
    assert.equal(isTargetMutation({ kind: 'database', op: 'replace', database: { id, workspaceId, title, columns, views } }), true, type);
  }
  assert.equal(parsePageDatabaseOps([{ op: 'view.save', view: { name: 'Map', type: 'map', config: { filters: [], match: 'all', sorts: [] } } }], 'user').ok, false);
});

test('schema ordering, referential integrity, and user target failures are enforced', () => {
  const result = applyPageDatabaseOps(db, [
    { op: 'column.add', column: { id: 'priority', name: 'Priority', type: 'number' }, after: 'name' },
    { op: 'row.add', id: 'r2', values: { priority: 1 }, after: 'r1' },
  ], { actor: 'user', revision: 2, now: 20 });
  assert.deepEqual(result.database.columns.map((column) => column.id), ['name', 'priority', 'status']);
  assert.deepEqual(result.database.rows.map((row) => row.id), ['r1', 'r2']);
  assert.throws(() => applyPageDatabaseOps(db, [{ op: 'row.add', values: { missing: 'value' } }], { actor: 'user', revision: 2, now: 20, newId: () => 'r2' }), /unknown column/);
  assert.throws(() => applyPageDatabaseOps(db, [{ op: 'row.update', id: 'absent', values: { name: 'x' } }], { actor: 'user', revision: 2, now: 20 }), /target_missing/);
  const agent = applyPageDatabaseOps(db, [{ op: 'row.delete', id: 'r1', expectRev: 8 }], { actor: 'agent', revision: 2, now: 20 });
  assert.deepEqual(agent.rejectedOps, [{ index: 0, reason: 'revision_conflict' }]);
  assert.equal(agent.changed, false);
});

test('deleting a column removes its saved view references and keeps board grouping usable', () => {
  const referenced: PageDatabase = {
    ...db,
    columns: [...db.columns, { id: 'priority', name: 'Priority', type: 'select', options: [{ value: 'high' }] }],
    views: [{
      id: 'board', name: 'Board', type: 'board', position: 0,
      config: {
        filters: [{ column: 'status', op: 'is', value: 'todo' }], match: 'all',
        sorts: [{ column: 'status', dir: 'asc' }], group: 'status', visible: ['name', 'status'],
        date: 'status', planDate: 'status', cover: 'status',
      },
    }],
  };
  const result = applyPageDatabaseOps(referenced, [{ op: 'column.delete', id: 'status' }], { actor: 'user', revision: 2, now: 20 });
  const view = result.database.views[0]!;
  assert.deepEqual(view.config, { filters: [], match: 'all', sorts: [], visible: ['name'] });
  assert.equal(effectiveConfig(result.database, view).group, 'priority');
  assert.deepEqual(result.database.rows[0]?.values, { name: 'Build' });
});

test('a Conversations column and its waiting filter pass the edit and history validators', () => {
  const column = { name: 'Conversations', type: 'threads' };
  assert.equal(parsePageDatabaseOps([{ op: 'column.add', column }], 'user').ok, true);
  assert.equal(parsePageDatabaseOps([{ op: 'column.update', id: 'name', patch: { type: 'threads' } }], 'user').ok, true);
  const view = { name: 'Needs you', type: 'list', config: { filters: [{ column: 'threads', op: 'waiting' }], match: 'any', sorts: [] } };
  assert.equal(parsePageDatabaseOps([{ op: 'view.save', view }], 'user').ok, true);
  assert.equal(parsePageDatabaseOps([{ op: 'view.save', view: { ...view, config: { ...view.config, filters: [{ column: 'threads', op: 'sleeping' }] } } }], 'user').ok, false);
  assert.ok(isTargetMutation({ kind: 'database', op: 'replace', database: {
    id: 'db1', workspaceId: 'ws1', title: 'Tasks',
    columns: [{ id: 'threads', name: 'Conversations', type: 'threads' }],
    views: [{ id: 'v', name: 'Needs you', type: 'list', position: 0, config: { filters: [{ column: 'threads', op: 'waiting' }], match: 'any', sorts: [] } }],
  } }), 'history keeps a Conversations column and a waiting filter');
});
