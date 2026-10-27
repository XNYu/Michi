import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createDatabase, getDatabase } from '../src/services/pages/repository';
import { applyAgentDbEdits, applyComponentDbEdits, applyUserDatabaseEdits, configureDatabaseView } from '../src/services/pages/databaseWrites';
import { PageWriteError } from '../src/services/pages/core';
import { pageComponents } from '../src/services/pages/components';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-db-write-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run('ws', 'Workspace', 'alice');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function database() {
  return createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10,
    columns: [{ id: 'task', name: 'Task', type: 'text' }, { id: 'status', name: 'Status', type: 'text' }],
    views: [],
    rows: [{ id: 'r1', position: 0, values: { task: 'Ship', status: 'todo' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 10 }],
  });
}

function activeChatSource() {
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('n','ws','chat','running',1)").run();
  getDb().prepare(`INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at)
    VALUES ('turn','n','assistant','active',1,1)`).run();
  return { kind: 'chat' as const, nodeId: 'n', turnId: 'turn', assistantId: 'assistant' };
}
function attachDatabaseToPage(databaseId: string) {
  getDb().prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,parent_id,position,title,color,blocks,revision,view_version,updated_at,updated_by,created_at)
    VALUES ('page','alice','ws',NULL,0,'Page',NULL,'[]',1,1,1,'user',1)`).run();
  getDb().prepare('INSERT INTO page_database_refs(page_id,database_id) VALUES (\'page\',?)').run(databaseId);
}

test('user writes compare the database revision and record typed row history in one batch', () => {
  const db = database();
  attachDatabaseToPage(db.id);
  const result = applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [{ op: 'row.update', id: 'r1', values: { task: 'Ship it' } }], now: 20 });
  assert.equal(result.revision, 2);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0]?.target.kind, 'row');
  assert.equal(result.applied[0]?.before?.kind, 'row');
  assert.equal(result.applied[0]?.forward.kind, 'row');
  assert.equal(getDatabase(db.id, 'alice').rows[0]?.edited.task, 20);
  assert.equal((getDb().prepare("SELECT view_version FROM pages WHERE id='page'").get() as { view_version: number }).view_version, 2);
  assert.throws(() => applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [{ op: 'row.update', id: 'r1', values: { task: 'stale' } }] }),
  (error: unknown) => error instanceof PageWriteError && error.code === 'stale_revision');
});

test('agent updates split human-owned cells into a proposal at the post-split row revision', () => {
  const db = database();
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [{ op: 'row.update', id: 'r1', values: { task: 'Human task' } }], now: 20 });
  const result = applyAgentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', source: activeChatSource(),
    ops: [{ op: 'row.update', id: 'r1', expectRev: 2, values: { task: 'Agent task', status: 'done' } }], now: 30 });
  assert.equal(result.applied.length, 1);
  assert.equal(result.proposed.length, 1);
  assert.equal(result.proposed[0]?.baseRev, result.applied[0]?.appliedRev);
  assert.deepEqual(result.proposed[0]?.target.kind === 'row' ? result.proposed[0].target.columnIds : [], ['task']);
  assert.deepEqual(getDatabase(db.id, 'alice').rows[0]?.values, { task: 'Human task', status: 'done' });
  assert.equal(getDatabase(db.id, 'alice').rows[0]?.rev, 3);
});

test('agent row IDs are server assigned, stale and duplicate row writes return per-op rejections', () => {
  const db = database();
  const result = applyAgentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', source: activeChatSource(),
    ops: [
      { op: 'row.add', id: 'client-picked', values: { task: 'New' } },
      { op: 'row.update', id: 'r1', expectRev: 2, values: { status: 'done' } },
      { op: 'row.update', id: 'r1', expectRev: 2, values: { status: 'done' } },
    ], now: 40 });
  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.equal(result.rejected[0]?.reason, 'stale');
  assert.equal(result.rejected[1]?.reason, 'invalid');
  assert.ok(getDatabase(db.id, 'alice').rows.some((row) => row.id !== 'r1' && row.id !== 'client-picked'));
});

test('a malformed agent operation is rejected while valid independent operations commit', () => {
  const db = database();
  const result = applyAgentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', source: activeChatSource(),
    ops: [
      { op: 'row.update', id: 'r1', values: { status: 'done' } },
      { op: 'row.add', values: { task: 'Valid row' } },
    ], now: 40 });
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.rejected.map((item) => [item.index, item.reason]), [[0, 'invalid']]);
  assert.equal(getDatabase(db.id, 'alice').rows.length, 2);
});

test('an invalid user batch rolls back every operation', () => {
  const db = database();
  assert.throws(() => applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [
      { op: 'row.update', id: 'r1', values: { task: 'Would apply' } },
      { op: 'row.update', id: 'missing', values: { task: 'Invalid target' } },
    ], now: 20 }), (error: unknown) => error instanceof PageWriteError && error.status === 400);
  assert.equal(getDatabase(db.id, 'alice').revision, 1);
  assert.equal(getDatabase(db.id, 'alice').rows[0]?.values.task, 'Ship');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM page_changes').get() &&
    (getDb().prepare('SELECT COUNT(*) AS count FROM page_changes').get() as { count: number }).count, 0);
});

test('deleting a row with human-owned content creates a delete proposal', () => {
  const db = database();
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [{ op: 'row.update', id: 'r1', body: 'Human notes' }], now: 20 });
  const result = applyAgentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', source: activeChatSource(),
    ops: [{ op: 'row.delete', id: 'r1', expectRev: 2 }], now: 30 });
  assert.equal(result.proposed.length, 1);
  assert.equal(result.applied.length, 0);
  assert.equal(getDatabase(db.id, 'alice').rows.length, 1);
  assert.equal(result.proposed[0]?.forward.op, 'delete');
});

test('proposal-only agent writes keep content revision and invalidate the referencing view once', () => {
  const db = database();
  attachDatabaseToPage(db.id);
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [{ op: 'row.update', id: 'r1', body: 'Human notes' }], now: 20 });
  const result = applyAgentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', source: activeChatSource(),
    ops: [{ op: 'row.update', id: 'r1', expectRev: 2, body: 'Agent notes' }], now: 30 });
  assert.equal(result.applied.length, 0);
  assert.equal(result.proposed.length, 1);
  assert.equal(result.revision, 2);
  assert.equal(getDatabase(db.id, 'alice').revision, 2);
  assert.equal((getDb().prepare("SELECT view_version FROM pages WHERE id='page'").get() as { view_version: number }).view_version, 3);
});

test('destructive schema edits record affected row history alongside the schema change', () => {
  const db = database();
  const result = applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [{ op: 'column.delete', id: 'status' }], now: 20 });
  assert.equal(result.applied.length, 2);
  assert.deepEqual(result.applied.map((change) => change.target.kind).sort(), ['database', 'row']);
  assert.deepEqual(getDatabase(db.id, 'alice').rows[0]?.values, { task: 'Ship' });
  assert.equal(getDatabase(db.id, 'alice').rows[0]?.rev, 2);
});

test('deleting a row dismisses its pending agent proposals in the same transaction', () => {
  const db = database();
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 1,
    ops: [{ op: 'row.update', id: 'r1', values: { task: 'Human task' } }], now: 20 });
  const proposal = applyAgentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', source: activeChatSource(),
    ops: [{ op: 'row.update', id: 'r1', expectRev: 2, values: { task: 'Agent proposal' } }], now: 30 });
  assert.equal(proposal.proposed.length, 1);
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 2,
    ops: [{ op: 'row.delete', id: 'r1' }], now: 40 });
  const state = getDb().prepare('SELECT proposal_state FROM page_changes WHERE id=?').get(proposal.proposed[0]!.id) as { proposal_state: string };
  assert.equal(state.proposal_state, 'dismissed');
  assert.equal(getDatabase(db.id, 'alice').rows.length, 0);
});

test('component database-view writes run through row protection and retain component provenance', () => {
  const source = activeChatSource();
  const component = pageComponents.save('ws', 'alice', { expectedLibraryRevision: 0, source, input: {
    name: 'row-writer', description: 'Row writer', code: 'root.textContent = "Ready";',
  } }).component;
  const db = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10,
    columns: [{ id: 'task', name: 'Task', type: 'text' }],
    views: [{ id: 'v1', name: 'Custom', type: 'table', config: { filters: [], match: 'all', sorts: [] }, position: 0 }],
    rows: [{ id: 'r1', position: 0, values: { task: 'Ship' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 10 }],
  });
  const configured = configureDatabaseView({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 1,
    viewId: 'v1', componentId: component.id, props: {}, source, now: 20 });
  assert.equal(configured.revision, 2);
  assert.equal(getDatabase(db.id, 'alice').views[0]?.type, 'custom');
  let authorized = false;
  const result = applyComponentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice',
    componentId: component.id, version: 1, host: { kind: 'database_view', databaseId: db.id, viewId: 'v1' },
    ops: [{ op: 'row.update', id: 'r1', expectRev: 1, values: { task: 'Component edit' } }],
    authorize: () => { authorized = true; }, now: 30 });
  assert.equal(authorized, true);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0]?.source, { kind: 'component', componentId: component.id, version: 1, databaseId: db.id, viewId: 'v1' });
  assert.equal(getDatabase(db.id, 'alice').rows[0]?.values.task, 'Component edit');
});

test('component database-view capability failure leaves rows untouched', () => {
  const source = activeChatSource();
  const component = pageComponents.save('ws', 'alice', { expectedLibraryRevision: 0, source, input: {
    name: 'row-writer', description: 'Row writer', code: 'root.textContent = "Ready";',
  } }).component;
  const db = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10,
    columns: [{ id: 'task', name: 'Task', type: 'text' }],
    views: [{ id: 'v1', name: 'Custom', type: 'table', config: { filters: [], match: 'all', sorts: [] }, position: 0 }],
    rows: [{ id: 'r1', position: 0, values: { task: 'Ship' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 10 }],
  });
  configureDatabaseView({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 1,
    viewId: 'v1', componentId: component.id, props: {}, source, now: 20 });
  assert.throws(() => applyComponentDbEdits({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice',
    componentId: component.id, version: 1, host: { kind: 'database_view', databaseId: db.id, viewId: 'v1' },
    ops: [{ op: 'row.update', id: 'r1', expectRev: 1, values: { task: 'Must not apply' } }],
    authorize: () => { throw new PageWriteError(409, 'stale_revision', 'Capability was revoked'); }, now: 30 }),
  (error: unknown) => error instanceof PageWriteError && error.code === 'stale_revision');
  assert.equal(getDatabase(db.id, 'alice').rows[0]?.values.task, 'Ship');
});

test('agent configure of a human-edited custom view creates a proposal without changing the database revision', () => {
  const source = activeChatSource();
  const component = pageComponents.save('ws', 'alice', { expectedLibraryRevision: 0, source, input: {
    name: 'view-renderer', description: 'View renderer', code: 'root.textContent = "Ready";',
  } }).component;
  const db = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10,
    columns: [{ id: 'task', name: 'Task', type: 'text' }],
    views: [{ id: 'v1', name: 'Custom', type: 'table', config: { filters: [], match: 'all', sorts: [] }, position: 0 }], rows: [],
  });
  configureDatabaseView({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 1,
    viewId: 'v1', componentId: component.id, props: {}, source, now: 20 });
  const humanView = getDatabase(db.id, 'alice').views[0]!;
  applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice', revision: 2, now: 30,
    ops: [{ op: 'view.save', view: { id: 'v1', name: humanView.name, type: 'custom', config: humanView.config } }] });
  const proposed = configureDatabaseView({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 3,
    viewId: 'v1', componentId: component.id, props: { changed: true }, source, now: 40 });
  assert.equal(proposed.applied.length, 0);
  assert.equal(proposed.proposed.length, 1);
  assert.equal(proposed.proposed[0]?.target.kind, 'database');
  assert.equal(proposed.revision, 3);
  assert.deepEqual(getDatabase(db.id, 'alice').views[0]?.config.props, {});
});

test('configure_database_view creates a view when omitted and clears a prior pin when version is omitted', () => {
  const source = activeChatSource();
  const component = pageComponents.save('ws', 'alice', { expectedLibraryRevision: 0, source, input: {
    name: 'custom-renderer', description: 'Custom renderer', code: 'root.textContent = "Ready";',
  } }).component;
  const db = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 10,
    columns: [{ id: 'task', name: 'Task', type: 'text' }], views: [], rows: [],
  });
  const created = configureDatabaseView({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 1,
    componentId: component.id, props: {}, source, now: 20 });
  assert.equal(created.revision, 2);
  assert.equal(created.viewId, created.applied[0]?.after?.kind === 'database' && created.applied[0].after.exists
    ? created.applied[0].after.database.views[0]?.id : undefined);
  const first = getDatabase(db.id, 'alice').views[0]!;
  assert.equal(first.name, 'custom-renderer');
  assert.equal(first.type, 'custom');
  assert.deepEqual(first.config.filters, []);
  assert.equal(first.config.match, 'all');
  assert.deepEqual(first.config.sorts, []);
  assert.equal(first.config.pinnedVersion, undefined);
  configureDatabaseView({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 2,
    viewId: created.viewId, componentId: component.id, props: {}, pinnedVersion: 1, source, now: 30 });
  assert.equal(getDatabase(db.id, 'alice').views[0]?.config.pinnedVersion, 1);
  configureDatabaseView({ databaseId: db.id, workspaceId: 'ws', ownerUserId: 'alice', revision: 3,
    viewId: created.viewId, componentId: component.id, props: { mode: 'active' }, source, now: 40 });
  assert.equal(getDatabase(db.id, 'alice').views[0]?.config.pinnedVersion, undefined);
  assert.deepEqual(getDatabase(db.id, 'alice').views[0]?.config.props, { mode: 'active' });
});

test('moving a card back restores the order after a move to the top and after a move down one', () => {
  const db = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Moves', now: 70,
    columns: [{ id: 'status', name: 'Status', type: 'text' }], views: [],
    rows: ['a', 'b', 'c'].map((id, i) => ({ id, position: i, values: { status: 'Todo' }, rev: 1, edited: {}, bodyEditedAt: null, updatedAt: 70 })) });
  const order = () => getDatabase(db.id, 'alice').rows.map((r) => r.id).join('');
  const move = (id: string, after: string | null) => applyUserDatabaseEdits({ databaseId: db.id, ownerUserId: 'alice',
    revision: getDatabase(db.id, 'alice').revision, now: 71, ops: [{ op: 'row.move', id, after }] });
  move('c', null);
  assert.equal(order(), 'cab');
  move('c', 'b');
  assert.equal(order(), 'abc');
  move('a', 'b');
  assert.equal(order(), 'bac');
  move('a', null);
  assert.equal(order(), 'abc');
});
