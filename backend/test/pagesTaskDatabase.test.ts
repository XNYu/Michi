import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { TASK_VIEW } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError } from '../src/services/pages/core';
import { createDatabase, createPage, deletePage, getDatabase, getPage, restorePageDeletionGroup } from '../src/services/pages/repository';
import { applyUserDatabaseEdits } from '../src/services/pages/databaseWrites';
import { setupPagesRoutes } from '../src/routes/pages';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { acceptProposal, revertBatch, revertChange } from '../src/services/pages/pageChanges';
import { getChange } from '../src/services/pages/historyRepository';
import { applyAgentDbEdits } from '../src/services/pages/databaseWrites';
import { findTaskDatabaseId, openTaskDatabase } from '../src/services/pages/taskDatabase';
import { listEligibleMaintenanceManifest } from '../src/services/pages/maintenanceRepository';

test('the Pages Home system workspace has no task database to open', () => {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,settings) VALUES (?,?,?,1,1,?)')
    .run('sys', 'System', 'alice', JSON.stringify({ system: 'assistant' }));
  getDb().prepare("INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at,role) VALUES ('home','alice','sys','Home','[]',1,1,'spaces-home')").run();
  assert.throws(() => openTaskDatabase({ workspaceId: 'sys', ownerUserId: 'alice' }),
    (error) => error instanceof PageWriteError && error.status === 400 && error.code === 'tasks_need_workspace' &&
      /Pages Home has no task database/.test(error.message));
  assert.equal(findTaskDatabaseId('sys', 'alice'), null);
});

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-task-db-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  workspace.run('ws', 'Workspace', 'alice');
  workspace.run('other', 'Elsewhere', 'alice');
  const node = getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES (?,?,'chat','idle',1)");
  node.run('n1', 'ws');
  node.run('n2', 'ws');
  node.run('away', 'other');
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const refs = (pageId: string) => (getDb().prepare('SELECT database_id FROM page_database_refs WHERE page_id=? ORDER BY database_id').all(pageId) as Array<{ database_id: string }>)
  .map((row) => row.database_id);

test('a workspace gets one task database, made the first time it is asked for', () => {
  assert.equal(findTaskDatabaseId('ws', 'alice'), null);
  const first = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice', now: 10 });
  assert.equal(first.created, true);
  assert.equal(first.database.role, 'tasks');
  assert.equal(first.database.title, 'Tasks');
  assert.deepEqual(first.database.views.map((view) => view.id), [TASK_VIEW.board, TASK_VIEW.table, TASK_VIEW.needsYou]);
  const again = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice', now: 20 });
  assert.equal(again.created, false);
  assert.equal(again.database.id, first.database.id);
  assert.equal(findTaskDatabaseId('ws', 'alice'), first.database.id);
  assert.notEqual(openTaskDatabase({ workspaceId: 'other', ownerUserId: 'alice' }).database.id, first.database.id);
  assert.throws(() => openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'mallory' }), (error: unknown) => error instanceof PageWriteError && error.status === 404);
});

test('the store keeps at most one live task database per workspace and owner', () => {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice' });
  assert.throws(() => getDb().prepare(`INSERT INTO page_databases(id,owner_user_id,workspace_id,title,columns_json,views_json,revision,updated_at,created_at,role)
    VALUES ('db-dup','alice','ws','Tasks','[]','[]',1,1,1,'tasks')`).run(), /UNIQUE/);
  assert.equal(findTaskDatabaseId('ws', 'alice'), database.id);
});

test('a page with a task board at any depth refers to the task database, also when the board came first', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Plan', now: 1 });
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, ops: [{ op: 'insert', after: null,
    block: { type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'task-view' }] }] } }] });
  assert.deepEqual(refs(page.id), [], 'no task database yet');
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice' });
  assert.deepEqual(refs(page.id), [database.id], 'opening the task database picks up boards placed before it');
  const second = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Board', now: 2 });
  applyUserPageEdits({ pageId: second.id, ownerUserId: 'alice', revision: second.revision, ops: [{ op: 'insert', after: null, block: { type: 'task-view' } }] });
  assert.deepEqual(refs(second.id), [database.id]);
});

const editTasks = (databaseId: string, ops: unknown[]) =>
  applyUserDatabaseEdits({ databaseId, ownerUserId: 'alice', revision: getDatabase(databaseId, 'alice').revision, ops });

test('people rename core columns but cannot delete them or change their type', () => {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice' });
  editTasks(database.id, [{ op: 'column.update', id: 'next', patch: { name: 'Next' } }]);
  const renamed = getDatabase(database.id, 'alice');
  assert.equal(renamed.columns.find((column) => column.id === 'next')?.name, 'Next');
  for (const op of [
    { op: 'column.delete', id: 'status' },
    { op: 'column.update', id: 'threads', patch: { type: 'text' } },
    { op: 'column.update', id: 'status', patch: { options: [{ value: 'todo' }, { value: 'done' }] } },
    { op: 'column.add', column: { name: 'More', type: 'threads' } },
  ]) {
    assert.throws(() => editTasks(database.id, [op]), (error: unknown) => error instanceof PageWriteError && error.status === 400, JSON.stringify(op));
  }
  assert.equal(getDatabase(database.id, 'alice').revision, renamed.revision, 'a refused edit changes nothing');
  editTasks(database.id, [{ op: 'column.add', column: { name: 'Owner', type: 'text' } }]);
  assert.ok(getDatabase(database.id, 'alice').columns.some((column) => column.name === 'Owner'), 'their own columns are fine');
});

test('only the task database takes a Conversations column', () => {
  const plain = createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Plain', columns: [{ id: 'name', name: 'Name', type: 'text' }], views: [] });
  assert.throws(() => applyUserDatabaseEdits({ databaseId: plain.id, ownerUserId: 'alice', revision: plain.revision,
    ops: [{ op: 'column.add', column: { name: 'Chats', type: 'threads' } }] }), /Only a task database/);
  assert.throws(() => createDatabase({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Chats', columns: [{ id: 'c', name: 'Chats', type: 'threads' }], views: [] }), /Only a task database/);
});

test('a task links conversations of its workspace, each once and at most twenty', () => {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice' });
  editTasks(database.id, [{ op: 'row.add', id: 'r1', values: { task: 'Ship', status: 'doing', threads: ['n1'] } }]);
  assert.throws(() => editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads: ['n1', 'away'] } }]), /Conversation away is not a conversation of this workspace/);
  assert.throws(() => editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads: ['n1', 'missing'] } }]), /Conversation missing/);
  assert.throws(() => editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads: ['n1', 'n1'] } }]), /each conversation once/);
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('digest','ws','digest','idle',1)").run();
  assert.throws(() => editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads: ['digest'] } }]), /Conversation digest/);
  // One linked already stays linked after it is deleted, so the others can still change and it can be unlinked.
  getDb().prepare("UPDATE nodes SET deleted_at=5 WHERE id='n1'").run();
  editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads: ['n1', 'n2'] } }]);
  editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads: ['n2'] } }]);
  assert.deepEqual(getDatabase(database.id, 'alice').rows[0]!.values.threads, ['n2']);
  const many = Array.from({ length: 21 }, (_, index) => `m${index}`);
  for (const nodeId of many) getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES (?,'ws','chat','idle',1)").run(nodeId);
  assert.throws(() => editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads: many } }]), /at most 20/);
});

test('a task answers a non-id as such, not as a repeated link', () => {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice' });
  editTasks(database.id, [{ op: 'row.add', id: 'r1', values: { task: 'Ship', status: 'doing' } }]);
  for (const threads of [[''], ['n1', '']]) {
    assert.throws(() => editTasks(database.id, [{ op: 'row.update', id: 'r1', values: { threads } }]), /Conversations holds conversation ids/, JSON.stringify(threads));
  }
});

test('reverting a row delete restores its links even when a conversation was deleted since', () => {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice' });
  editTasks(database.id, [{ op: 'row.add', id: 'r1', values: { task: 'Ship', status: 'doing', threads: ['n1', 'n2'] } }]);
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('node','ws','chat','idle')").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('turn','node','assistant','active',1,1)").run();
  const source = { kind: 'chat' as const, nodeId: 'node', turnId: 'turn', assistantId: 'assistant' };
  const rev = getDatabase(database.id, 'alice').rows[0]!.rev;
  const result = applyAgentDbEdits({ databaseId: database.id, workspaceId: 'ws', ownerUserId: 'alice', source, now: 20,
    ops: [{ op: 'row.delete', id: 'r1', expectRev: rev }] });
  assert.equal(result.proposed.length, 1, JSON.stringify(result));
  acceptProposal(result.proposed[0]!.id, 'alice', 21);
  assert.equal(getDatabase(database.id, 'alice').rows.length, 0);
  getDb().prepare("UPDATE nodes SET deleted_at=5 WHERE id='n1'").run();
  getDb().prepare("UPDATE nodes SET workspace_id='other' WHERE id='n2'").run();
  revertChange(result.proposed[0]!.id, 'alice', 22);
  assert.deepEqual(getDatabase(database.id, 'alice').rows[0]!.values.threads, ['n1', 'n2']);
});

test('the task database belongs to the workspace: deleting the pages that show it keeps the tasks', () => {
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice' });
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Board', now: 1 });
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision, ops: [{ op: 'insert', after: null, block: { type: 'task-view' } }] });
  deletePage(page.id, 'alice', { now: 3 });
  assert.equal(getDatabase(database.id, 'alice').id, database.id);
  assert.equal(findTaskDatabaseId('ws', 'alice'), database.id);
});

test('a trashed page that shows a task board still refers to the task database made meanwhile', () => {
  const board = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Board', now: 1 });
  applyUserPageEdits({ pageId: board.id, ownerUserId: 'alice', revision: board.revision, ops: [{ op: 'insert', after: null, block: { type: 'task-view' } }] });
  const plain = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Plain', now: 1 });
  const groupId = deletePage(board.id, 'alice', { now: 3 });
  deletePage(plain.id, 'alice', { now: 3 });
  const { database } = openTaskDatabase({ workspaceId: 'ws', ownerUserId: 'alice', now: 5 });
  assert.deepEqual(refs(board.id), [database.id]);
  assert.deepEqual(refs(plain.id), []);
  const manifest = listEligibleMaintenanceManifest('ws', 'alice');
  assert.deepEqual(manifest.databases.find((item) => item.id === database.id)?.pageIds, []);
  assert.equal(manifest.pages.some((page) => page.id === board.id), false);
  restorePageDeletionGroup(groupId, 'alice', { now: 6 });
  assert.deepEqual(refs(board.id), [database.id]);
});

test('the task database routes read its id and open it once', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', setupPagesRoutes());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workspaces`;
  try {
    assert.deepEqual(await (await fetch(`${base}/ws/task-database`)).json(), { databaseId: null });
    const made = await fetch(`${base}/ws/task-database`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(made.status, 201);
    const opened = await made.json() as { database: { id: string; role: string }; created: boolean };
    assert.equal(opened.created, true);
    assert.equal(opened.database.role, 'tasks');
    const again = await fetch(`${base}/ws/task-database`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(again.status, 200);
    assert.equal((await again.json() as { database: { id: string } }).database.id, opened.database.id);
    assert.deepEqual(await (await fetch(`${base}/ws/task-database`)).json(), { databaseId: opened.database.id });
    assert.equal((await fetch(`${base}/ws/task-database`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Mine"}' })).status, 400);
    assert.equal((await fetch(`${base}/ws/task-database?x=1`)).status, 400);
    assert.equal((await fetch(`${base}/nope/task-database`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function homePage(withBoard = false) {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,settings) VALUES (?,?,?,1,1,?)')
    .run('sys', 'System', 'alice', JSON.stringify({ system: 'assistant' }));
  // A board already stored there predates the guard, so it is copied in from an ordinary page's stored blocks.
  let blocks = '[]';
  if (withBoard) {
    const source = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Source', template: 'blank', now: 1 });
    applyUserPageEdits({ pageId: source.id, ownerUserId: 'alice', revision: source.revision, ops: [{ op: 'insert', after: null, block: { type: 'task-view' } }] });
    // Without the person-edit marker, so an agent can change it directly instead of only proposing.
    blocks = JSON.stringify(getPage(source.id, 'alice').blocks.map(({ edit: _edit, ...block }) => block));
  }
  getDb().prepare("INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at,role) VALUES ('home','alice','sys','Home',?,1,1,'spaces-home')").run(blocks);
  return getPage('home', 'alice');
}

const refusedBoard = (error: unknown) => error instanceof PageWriteError && error.status === 400 && error.code === 'task_board_needs_workspace' &&
  /Pages Home/.test(error.message);

test('a task board is refused on a Pages Home page, also inside a container, and the page is left unchanged', () => {
  const page = homePage();
  const insert = (block: unknown) => () => applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: getPage(page.id, 'alice').revision, ops: [{ op: 'insert', after: null, block }] });
  assert.throws(insert({ type: 'task-view' }), refusedBoard);
  assert.throws(insert({ type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'task-view' }] }] }), refusedBoard);
  assert.equal(getPage(page.id, 'alice').blocks.length, 0);
  // The same inserts work on an ordinary workspace page.
  const ordinary = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Plan', template: 'blank', now: 3 });
  applyUserPageEdits({ pageId: ordinary.id, ownerUserId: 'alice', revision: ordinary.revision, ops: [{ op: 'insert', after: null, block: { type: 'task-view' } }] });
  assert.equal(getPage(ordinary.id, 'alice').blocks.length, ordinary.blocks.length + 1);
});

test('an agent write that adds a task board to a Pages Home page is refused', () => {
  const page = homePage();
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('snode','sys','chat','running',1)").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','snode','a','active',1,1)").run();
  assert.throws(() => applyAgentPageEdits({
    pageId: page.id, workspaceId: 'sys', ownerUserId: 'alice', source: { kind: 'chat', nodeId: 'snode', turnId: 't', assistantId: 'a' },
    ops: [{ op: 'insert', block: { type: 'task-view' }, after: null }],
  }), refusedBoard);
  assert.equal(getPage(page.id, 'alice').blocks.length, 0);
});

test('a Pages Home page that already holds a task board can still be saved with other edits', () => {
  const page = homePage(true);
  assert.ok(page.blocks.some((block) => block.type === 'task-view'));
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision,
    ops: [{ op: 'insert', after: page.blocks[0]!.id, block: { type: 'heading', text: 'More' } }] });
  assert.equal(getPage(page.id, 'alice').blocks.length, page.blocks.length + 1);
});

const homeSource = { kind: 'chat' as const, nodeId: 'snode', turnId: 't', assistantId: 'a' };
function homeTurn() {
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES ('snode','sys','chat','running',1)").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','snode','a','active',1,1)").run();
}

test('an agent update that nests a task board in a person-edited Pages Home block is a hard error, not a proposal', () => {
  const page = homePage();
  homeTurn();
  applyUserPageEdits({ pageId: page.id, ownerUserId: 'alice', revision: page.revision,
    ops: [{ op: 'insert', after: null, block: { type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'heading', text: 'Hi' }] }] } }] });
  const before = getPage(page.id, 'alice');
  const grid = before.blocks[0]!;
  const changes = () => (getDb().prepare('SELECT COUNT(*) AS n FROM page_changes').get() as { n: number }).n;
  const count = changes();
  assert.throws(() => applyAgentPageEdits({
    pageId: page.id, workspaceId: 'sys', ownerUserId: 'alice', source: homeSource, atomic: true,
    ops: [{ op: 'update', id: grid.id, expectRev: grid.rev, block: { type: 'grid', regions: [{ id: 'main', span: 12, blocks: [{ type: 'heading', text: 'Hi' }, { type: 'task-view' }] }] } }],
  }), refusedBoard);
  assert.equal(changes(), count);
  assert.deepEqual(getPage(page.id, 'alice'), before);
});

test('undoing a batch that deleted a Home board reports the refused restore as a conflict instead of aborting halfway', () => {
  const page = homePage(true);
  homeTurn();
  const board = page.blocks[0]!;
  const result = applyAgentPageEdits({
    pageId: page.id, workspaceId: 'sys', ownerUserId: 'alice', source: homeSource, atomic: true,
    ops: [{ op: 'delete', id: board.id, expectRev: board.rev }, { op: 'insert', after: null, block: { type: 'heading', text: 'New' } }],
  });
  assert.equal(result.applied.length, 2);
  const undone = revertBatch(result.applied[0]!.batchId!, 'alice', 'sys');
  assert.equal(undone.reverted.length, 1);
  assert.equal(undone.conflicts.length, 1);
  assert.match(undone.conflicts[0]!.message, /Pages Home/);
  assert.deepEqual(getPage(page.id, 'alice').blocks.map((block) => block.type), ['markdown']);
});

test('restoring a deleted Home board is refused and the change stays applied', () => {
  const page = homePage(true);
  homeTurn();
  const board = page.blocks[0]!;
  const result = applyAgentPageEdits({
    pageId: page.id, workspaceId: 'sys', ownerUserId: 'alice', source: homeSource, atomic: true,
    ops: [{ op: 'delete', id: board.id, expectRev: board.rev }],
  });
  const change = result.applied[0]!;
  const after = getPage(page.id, 'alice');
  assert.throws(() => revertChange(change.id, 'alice'), refusedBoard);
  assert.equal(getChange(change.id, 'alice').applicationState, 'applied');
  assert.deepEqual(getPage(page.id, 'alice'), after);
});
