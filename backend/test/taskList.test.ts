import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { setAiGlobalContext } from '../src/services/dbRepository';
import { PageWriteError } from '../src/services/pages/core';
import { applyAgentDbEdits, applyUserDatabaseEdits } from '../src/services/pages/databaseWrites';
import { configureHomeLiveWait } from '../src/services/pages/homeSections';
import { getDatabase } from '../src/services/pages/repository';
import { openTaskDatabase } from '../src/services/pages/taskDatabase';
import { listTasks, type TaskListInput } from '../src/services/pages/taskList';
import { seedConversation } from './helpers/homeConversations';

const OWNER = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-task-list-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  workspace.run('ws', 'rabbitholes', null);
  workspace.run('other', 'Elsewhere', null);
  const conversation = (nodeId: string, title: string, reply: string, ago = DAY, workspaceId = 'ws') =>
    seedConversation({ nodeId, workspaceId, title, turns: [{ status: 'completed', startedAt: NOW - ago, reply }] });
  conversation('asked', 'Schema naming', 'camelCase or snake_case?');
  conversation('quiet', 'Tests', 'All green.');
  conversation('stale', 'Old question', 'Which one?', 5 * DAY);
  conversation('moving', 'Moves away', 'Ship it?');
  conversation('there', 'Elsewhere', 'Done.', DAY, 'other');
  seedConversation({ nodeId: 'running', workspaceId: 'ws', title: 'Build', turns: [{ status: 'active', startedAt: NOW - 60_000, reply: '' }] });
});

afterEach(() => {
  configureHomeLiveWait(null);
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Seed { id: string; at: number; values: Record<string, unknown>; body?: string }

/** The workspace's task database with these tasks, written by the person, each last changed at its `at`. */
function seedTasks(workspaceId: string, rows: Seed[]): string {
  const { database } = openTaskDatabase({ workspaceId, ownerUserId: OWNER, now: 1 });
  applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: OWNER, revision: database.revision, now: 2,
    ops: rows.map((row) => ({ op: 'row.add', id: row.id, values: row.values, ...(row.body ? { body: row.body } : {}) })) });
  const stamp = getDb().prepare('UPDATE page_database_rows SET updated_at=? WHERE database_id=? AND id=?');
  for (const row of rows) stamp.run(row.at, database.id, row.id);
  return database.id;
}

const inWorkspace = (extra: Partial<TaskListInput> = {}) =>
  listTasks({ ownerUserId: OWNER, scope: { kind: 'workspace', workspaceId: 'ws' }, now: NOW, ...extra });
const ids = (result: { items: Array<{ rowId: string }> }) => result.items.map((item) => item.rowId);

const THREE = (): Seed[] => [
  { id: 'ship', at: NOW - 3000, values: { task: 'Ship the release', status: 'doing', threads: ['quiet'], next: 'Tag v2' } },
  { id: 'schema', at: NOW - 1000, values: { task: 'Pick a schema', status: 'todo', threads: ['asked'] } },
  { id: 'docs', at: NOW - 2000, values: { task: 'Write docs', status: 'done' }, body: 'Evidence: the docs merged.' },
];

test("another owner's task database is read by neither the across nor the workspace scope", () => {
  process.env.MICHI_CLOUD = '1';
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)').run('theirs', 'Theirs', 'bob');
  const { database } = openTaskDatabase({ workspaceId: 'theirs', ownerUserId: 'bob', now: 1 });
  applyUserDatabaseEdits({ databaseId: database.id, ownerUserId: 'bob', revision: database.revision, now: 2,
    ops: [{ op: 'row.add', id: 'secret', values: { task: 'Not yours', status: 'todo' } }] });
  const read = (scope: TaskListInput['scope']) => {
    try { return ids(listTasks({ ownerUserId: 'alice', scope, now: NOW })); } catch (error) {
      assert.ok(error instanceof PageWriteError && error.status === 404);
      return [];
    }
  };
  assert.deepEqual(read({ kind: 'across', workspaceIds: null, includeAiHidden: true }), []);
  assert.deepEqual(read({ kind: 'across', workspaceIds: ['theirs'], includeAiHidden: true }), []);
  assert.deepEqual(read({ kind: 'workspace', workspaceId: 'theirs' }), []);
  assert.deepEqual(ids(listTasks({ ownerUserId: 'bob', scope: { kind: 'across', workspaceIds: null, includeAiHidden: true }, now: NOW })), ['secret']);
});

test("a workspace's tasks read as compact rows, newest change first", () => {
  const databaseId = seedTasks('ws', THREE());
  seedTasks('other', [{ id: 'far', at: NOW, values: { task: 'Elsewhere', status: 'waiting' } }]);
  const result = inWorkspace();
  assert.deepEqual(ids(result), ['schema', 'docs', 'ship']);
  const rev = getDatabase(databaseId, OWNER).rows.find((row) => row.id === 'schema')!.rev;
  assert.deepEqual(result.items[0], {
    workspaceId: 'ws', workspaceName: 'rabbitholes', databaseId, rowId: 'schema', rev,
    task: 'Pick a schema', status: 'todo', statusSetBy: 'user', next: '',
    conversationIds: ['asked'], waitingConversationIds: ['asked'], needsYou: true, hasNotes: false, updatedAt: NOW - 1000,
  });
  assert.equal(result.items[1]!.hasNotes, true);
  assert.equal(result.items[2]!.needsYou, false, 'a linked conversation that answered does not wait on you');
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.skippedWorkspaces, []);
});

test('a status was set by the person, by an agent, or by nobody yet', () => {
  const databaseId = seedTasks('ws', [{ id: 'mine', at: NOW - 1000, values: { task: 'Mine', status: 'doing' } }]);
  applyAgentDbEdits({ databaseId, workspaceId: 'ws', ownerUserId: OWNER, now: 3,
    source: { kind: 'chat', nodeId: 'running', turnId: 'running-t0', assistantId: 'running-t0-a' },
    ops: [{ op: 'row.add', values: { task: 'From the agent', status: 'todo' } }, { op: 'row.add', values: { task: 'No status yet' } }] });
  const setBy = Object.fromEntries(inWorkspace().items.map((item) => [item.task, item.statusSetBy]));
  assert.deepEqual(setBy, { Mine: 'user', 'From the agent': 'agent', 'No status yet': null });
});

test('filters on status, a conversation, words and time, and pages with a cursor', () => {
  seedTasks('ws', THREE());
  assert.deepEqual(ids(inWorkspace({ statuses: ['done', 'doing'] })), ['docs', 'ship']);
  assert.deepEqual(ids(inWorkspace({ nodeId: 'quiet' })), ['ship']);
  assert.deepEqual(ids(inWorkspace({ query: 'TAG v' })), ['ship'], 'the next step counts');
  assert.deepEqual(ids(inWorkspace({ query: 'evidence' })), ['docs'], 'so do the notes');
  assert.deepEqual(ids(inWorkspace({ updatedSince: NOW - 2000 })), ['schema', 'docs']);
  const first = inWorkspace({ limit: 2 });
  assert.deepEqual(ids(first), ['schema', 'docs']);
  assert.ok(first.nextCursor);
  const rest = inWorkspace({ limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(ids(rest), ['ship']);
  assert.equal(rest.nextCursor, null);
  for (const bad of [{ cursor: 'nope' }, { limit: 0 }, { limit: 201 }]) {
    assert.throws(() => inWorkspace(bad), (error: unknown) => error instanceof PageWriteError && error.status === 400, JSON.stringify(bad));
  }
});

test('needs you: waiting on you, or linking a conversation of its workspace that waits on you now', () => {
  seedTasks('ws', [
    { id: 'decide', at: NOW - 1000, values: { task: 'Decide the name', status: 'waiting' } },
    { id: 'schema', at: NOW - 2000, values: { task: 'Pick a schema', status: 'doing', threads: ['quiet', 'asked'] } },
    { id: 'old', at: NOW - 3000, values: { task: 'Old question', status: 'doing', threads: ['stale'] } },
    { id: 'build', at: NOW - 4000, values: { task: 'Build', status: 'doing', threads: ['running'] } },
    { id: 'moved', at: NOW - 5000, values: { task: 'Moved', status: 'todo', threads: ['moving'] } },
  ]);
  getDb().prepare("UPDATE nodes SET workspace_id='other' WHERE id='moving'").run();
  const waiting = inWorkspace({ needsYou: true });
  assert.deepEqual(ids(waiting), ['decide', 'schema'], 'a stalled question and one that moved away do not count');
  assert.deepEqual(waiting.items[1]!.waitingConversationIds, ['asked']);
  configureHomeLiveWait((nodeId) => (nodeId === 'running' ? { kind: 'approval', text: 'Run the tests' } : null));
  assert.deepEqual(ids(inWorkspace({ needsYou: true })), ['decide', 'schema', 'build'], 'a running turn that waits for approval counts');
  const one = inWorkspace({ needsYou: true, limit: 1 });
  assert.deepEqual(ids(one), ['decide']);
  assert.deepEqual(ids(inWorkspace({ needsYou: true, cursor: one.nextCursor! })), ['schema', 'build']);
});

test('across workspaces: every one or the named ones, leaving out archived ones and those hidden from AI navigation', () => {
  seedTasks('ws', [{ id: 'here', at: NOW - 2000, values: { task: 'Here', status: 'todo' } }]);
  seedTasks('other', [{ id: 'far', at: NOW - 1000, values: { task: 'Far', status: 'waiting', threads: ['there'] } }]);
  const across = (workspaceIds: string[] | null, includeAiHidden = false) =>
    listTasks({ ownerUserId: OWNER, scope: { kind: 'across', workspaceIds, includeAiHidden }, now: NOW });
  assert.deepEqual(across(null).items.map((item) => [item.rowId, item.workspaceName]), [['far', 'Elsewhere'], ['here', 'rabbitholes']]);
  assert.deepEqual(ids(across(['ws'])), ['here']);

  setAiGlobalContext('other', false);
  const hidden = across(null);
  assert.deepEqual(ids(hidden), ['here']);
  assert.deepEqual(hidden.skippedWorkspaces, [{ workspaceId: 'other', workspaceName: 'Elsewhere', reason: 'navigation-off' }]);
  assert.deepEqual(ids(across(null, true)), ['far', 'here'], 'the person still sees them');
  setAiGlobalContext('other', true);

  getDb().prepare("UPDATE workspaces SET archived_at=5 WHERE id='other'").run();
  assert.deepEqual(across(null).skippedWorkspaces, [], 'an archived workspace is simply out of view');
  const named = across(['other']);
  assert.deepEqual(ids(named), []);
  assert.deepEqual(named.skippedWorkspaces, [{ workspaceId: 'other', workspaceName: 'Elsewhere', reason: 'archived' }]);
  assert.deepEqual(ids(listTasks({ ownerUserId: OWNER, scope: { kind: 'workspace', workspaceId: 'other' }, now: NOW })), ['far'],
    'its own chats still read it');
});

test('reads the states of more linked conversations than one state read takes', () => {
  const nodeIds = Array.from({ length: 520 }, (_, index) => `c${index}`);
  for (const nodeId of nodeIds) {
    seedConversation({ nodeId, workspaceId: 'ws', turns: [{ status: 'completed', startedAt: NOW - DAY, reply: nodeId === 'c519' ? 'Which one?' : 'Done.' }] });
  }
  seedTasks('ws', Array.from({ length: 26 }, (_, index) => ({
    id: `t${index}`, at: NOW - index, values: { task: `Task ${index}`, status: 'doing', threads: nodeIds.slice(index * 20, index * 20 + 20) },
  })));
  assert.deepEqual(ids(inWorkspace({ needsYou: true })), ['t25']);
});
