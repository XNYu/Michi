import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { allTasksColumns, TASK_VIEW } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { setAiGlobalContext } from '../src/services/dbRepository';
import { PageWriteError } from '../src/services/pages/core';
import { applyUserDatabaseEdits } from '../src/services/pages/databaseWrites';
import { getDatabase } from '../src/services/pages/repository';
import { allTasks, editAllTasksViews } from '../src/services/pages/allTasks';
import { openTaskDatabase } from '../src/services/pages/taskDatabase';
import { setupSpacesHomeRoutes } from '../src/routes/spacesHome';

const OWNER = LOCAL_AGENT_OWNER_ID;
let dir: string;
let priorData: string | undefined;
let priorCloud: string | undefined;

beforeEach(() => {
  priorData = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-all-tasks-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,NULL,1,1)');
  workspace.run('ws', 'Alpha');
  workspace.run('other', 'Beta');
  workspace.run('quiet', 'Quiet');
  workspace.run('old', 'Old');
});

afterEach(() => {
  closeDb();
  if (priorData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorData;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A workspace's task database with these tasks, added by the person. */
function tasksIn(workspaceId: string, names: string[]): string {
  const { database } = openTaskDatabase({ workspaceId, ownerUserId: OWNER, now: 2 });
  applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: OWNER, revision: database.revision, now: 3,
    ops: names.map((task) => ({ op: 'row.add', values: { task, status: 'todo' } })) });
  return database.id;
}

test("All tasks reads every live workspace's task database, its statuses, and its own views", () => {
  const alpha = tasksIn('ws', ['Ship the release']);
  const beta = tasksIn('other', ['Plan the launch', 'Book the room']);
  const quiet = tasksIn('quiet', ['Quiet task']);
  tasksIn('old', ['Old task']);
  applyUserDatabaseEdits({ databaseId: beta, ownerUserId: OWNER, revision: getDatabase(beta, OWNER).revision, now: 4,
    ops: [{ op: 'option.add', id: 'status', option: { value: 'blocked', label: 'Blocked' } }] });
  setAiGlobalContext('quiet', false);
  getDb().prepare("UPDATE workspaces SET archived_at=5 WHERE id='old'").run();

  const all = allTasks(OWNER);
  assert.deepEqual(all.sources.map((source) => [source.workspaceName, source.databaseId, source.revision]), [
    ['Alpha', alpha, getDatabase(alpha, OWNER).revision],
    ['Beta', beta, getDatabase(beta, OWNER).revision],
    ['Quiet', quiet, getDatabase(quiet, OWNER).revision],
  ], "an archived workspace is out; one hidden from AI navigation is still the person's to see");
  assert.deepEqual(all.sources[1]!.statuses.map((option) => option.value), ['todo', 'doing', 'waiting', 'done', 'blocked']);
  assert.deepEqual(all.rows.map((entry) => [entry.databaseId, entry.row.values.task]).sort(), [
    [alpha, 'Ship the release'], [beta, 'Book the room'], [beta, 'Plan the launch'], [quiet, 'Quiet task'],
  ].sort());
  assert.deepEqual([all.views.map((view) => view.id), all.viewsRevision], [[TASK_VIEW.board, TASK_VIEW.table, TASK_VIEW.needsYou], 0]);

  const columns = allTasksColumns(all.sources);
  assert.deepEqual(columns.map((column) => column.id), ['task', 'status', 'threads', 'next', 'workspace']);
  assert.deepEqual(columns.find((column) => column.id === 'status')!.options!.map((option) => option.value), ['todo', 'doing', 'waiting', 'done', 'blocked']);
  assert.deepEqual(columns.find((column) => column.id === 'workspace')!.options,
    [{ value: 'ws', label: 'Alpha' }, { value: 'other', label: 'Beta' }, { value: 'quiet', label: 'Quiet' }]);
});

test('All tasks keeps its own views per person, and saves nothing but views', () => {
  tasksIn('ws', ['Ship the release']);
  const byWorkspace = { op: 'view.save', view: { name: 'By workspace', type: 'board', config: { filters: [], match: 'all', sorts: [], group: 'workspace' } } };
  const saved = editAllTasksViews({ ownerUserId: OWNER, revision: 0, now: 10, ops: [byWorkspace] });
  assert.deepEqual([saved.viewsRevision, saved.views.map((view) => view.name)], [1, ['Board', 'Table', 'Needs you', 'By workspace']]);
  assert.deepEqual(allTasks(OWNER).views, saved.views);

  const refused = (input: { revision: number; ops: unknown }, status: number, message: RegExp) => assert.throws(
    () => editAllTasksViews({ ownerUserId: OWNER, now: 11, ...input }),
    (error: unknown) => error instanceof PageWriteError && error.status === status && message.test(error.message), JSON.stringify(input.ops));
  refused({ revision: 0, ops: [byWorkspace] }, 409, /changed/);
  refused({ revision: 1, ops: [] }, 400, /No view changes/);
  refused({ revision: 1, ops: [{ op: 'row.add', values: { task: 'x' } }] }, 400, /only its views/);
  refused({ revision: 1, ops: [{ op: 'view.save', view: { name: 'Mine', type: 'custom', config: { filters: [], match: 'all', sorts: [], componentId: 'c1' } } }] }, 400, /no custom views/);
  refused({ revision: 1, ops: [{ op: 'view.save', view: { name: 'Owner', type: 'table', config: { filters: [], match: 'all', sorts: [{ column: 'owner', dir: 'asc' }] } } }] }, 400, /unknown column/);

  const deleted = editAllTasksViews({ ownerUserId: OWNER, revision: 1, now: 12, ops: [{ op: 'view.delete', id: TASK_VIEW.needsYou }] });
  assert.deepEqual(deleted.views.map((view) => view.name), ['Board', 'Table', 'By workspace']);
  assert.equal(editAllTasksViews({ ownerUserId: 'bob', revision: 0, now: 13, ops: [{ op: 'view.delete', id: TASK_VIEW.table }] }).viewsRevision, 1,
    'another person starts from the three task views');
});

test('the All tasks routes read the tasks and save the views', async () => {
  tasksIn('ws', ['Ship the release']);
  const app = express();
  app.use(express.json());
  app.use('/api', setupSpacesHomeRoutes({ clock: () => 20 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spaces-home/all-tasks`;
  const post = (body: unknown) => fetch(`${base}/views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const read = await (await fetch(base)).json() as { sources: Array<{ workspaceName: string }>; rows: unknown[]; viewsRevision: number };
    assert.deepEqual([read.sources.map((source) => source.workspaceName), read.rows.length, read.viewsRevision], [['Alpha'], 1, 0]);
    const saved = await post({ revision: 0, ops: [{ op: 'view.delete', id: TASK_VIEW.table }] });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as { viewsRevision: number }).viewsRevision, 1);
    assert.equal((await post({ revision: 0, ops: [{ op: 'view.delete', id: TASK_VIEW.board }] })).status, 409);
    assert.equal((await post({ revision: '1', ops: [] })).status, 400);
    assert.equal((await post({ revision: 1, ops: [], extra: true })).status, 400);
    assert.equal((await fetch(`${base}?x=1`)).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
