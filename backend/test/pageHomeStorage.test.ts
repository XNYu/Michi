import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PAGE_LAYOUT_RULE_LIMITS } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageWriteError } from '../src/services/pages/core';
import { createPage, getPage } from '../src/services/pages/repository';
import { addLayoutRule, deleteLayoutRule, listLayoutRules, parseLayoutRules } from '../src/services/pages/layoutRules';
import { getFirstRun, listFirstRuns, queueFirstRun, updateFirstRun } from '../src/services/pages/firstRun';
import { getSpacesHome } from '../src/services/pages/homePages';

let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-home-storage-'));
  process.env.MICHI_DATA_DIR = dir;
  process.env.MICHI_CLOUD = '1';
  closeDb(); initDb();
  const insert = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  insert.run('ws', 'Workspace', 'alice');
  insert.run('ws-b', 'Bob', 'bob');
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status) VALUES ('n','ws','chat','idle'),('nb','ws-b','chat','idle')").run();
  getDb().prepare(`INSERT INTO turns(turn_id,node_id,user_message_id,assistant_message_id,status,started_at,updated_at)
    VALUES ('t','n','u','a','completed',1,1),('tb','nb','ub','ab','completed',1,1)`).run();
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const status = (code: number) => (error: unknown) => error instanceof PageWriteError && error.status === code;

test('layout rules are added, listed in order and deleted on any page, the Spaces Home included', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release', now: 1 });
  const before = getPage(page.id, 'alice').viewVersion;
  const first = addLayoutRule({ pageId: page.id, ownerUserId: 'alice', text: '  Stalled lists only the last 3 days  ', createdBy: 'user', now: 10 });
  const second = addLayoutRule({ pageId: page.id, ownerUserId: 'alice', text: 'Progress keeps 3 items',
    sourceMessage: { nodeId: 'n', turnId: 't', messageId: 'u' }, createdBy: 'agent', now: 11 });
  assert.equal(first.text, 'Stalled lists only the last 3 days');
  assert.equal(first.sourceMessage, null);
  assert.deepEqual(listLayoutRules(page.id, 'alice'), [first, second]);
  assert.ok(getPage(page.id, 'alice').viewVersion > before, 'a rule change bumps the page view');
  assert.equal(getPage(page.id, 'alice').revision, page.revision, 'rules are not page content');
  assert.deepEqual(deleteLayoutRule(page.id, 'alice', first.id, 12), [second]);
  assert.throws(() => deleteLayoutRule(page.id, 'alice', first.id), status(404));

  const home = getSpacesHome('alice');
  addLayoutRule({ pageId: home.page.id, ownerUserId: 'alice', text: 'Waiting first', createdBy: 'user' });
  assert.equal(getSpacesHome('alice').layoutRules[0]?.text, 'Waiting first');
});

test('layout rules are validated, bounded, owner-scoped and read-only in an archived workspace', () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  const add = (extra: Record<string, unknown>, owner = 'alice') => addLayoutRule({ pageId: page.id, ownerUserId: owner, text: 'Rule', createdBy: 'user', ...extra });
  assert.throws(() => add({ text: '   ' }), status(400));
  assert.throws(() => add({ text: 'x'.repeat(PAGE_LAYOUT_RULE_LIMITS.text + 1) }), status(400));
  assert.throws(() => add({ sourceMessage: { nodeId: 'n', turnId: 't' } }), status(400));
  assert.throws(() => add({ sourceMessage: { nodeId: 'n', turnId: 't', messageId: 'forged' } }), status(404));
  assert.throws(() => add({ sourceMessage: { nodeId: 'nb', turnId: 'tb', messageId: 'ab' } }), status(404), 'another owner\'s message');
  assert.throws(() => add({ createdBy: 'system' }), status(400));
  assert.throws(() => add({}, 'bob'), status(404));
  assert.throws(() => listLayoutRules(page.id, 'bob'), status(404));
  for (let i = 0; i < PAGE_LAYOUT_RULE_LIMITS.perPage; i += 1) add({ text: `Rule ${i}` });
  assert.throws(() => add({}), status(409));
  getDb().prepare('UPDATE workspaces SET archived_at=5 WHERE id=?').run('ws');
  assert.equal(listLayoutRules(page.id, 'alice').length, PAGE_LAYOUT_RULE_LIMITS.perPage);
  assert.throws(() => deleteLayoutRule(page.id, 'alice', listLayoutRules(page.id, 'alice')[0]!.id), /read-only/);
});

test('stored rules that do not parse are left out instead of failing the page', () => {
  assert.deepEqual(parseLayoutRules('not json'), []);
  assert.deepEqual(parseLayoutRules(JSON.stringify([{ id: 'r', text: 'ok', sourceMessage: null, createdBy: 'user', createdAt: 1 }, { id: 'bad' }])),
    [{ id: 'r', text: 'ok', sourceMessage: null, createdBy: 'user', createdAt: 1 }]);
  const page = createPage({ workspaceId: 'ws', ownerUserId: 'alice', title: 'Release' });
  assert.throws(() => getDb().prepare("UPDATE pages SET layout_rules='{}' WHERE id=?").run(page.id), /CHECK constraint failed/);
});

test('a first run is queued once, resumes instead of restarting and only a failed one starts over', () => {
  const queued = queueFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', startSeq: 40, total: 17, now: 100 });
  assert.deepEqual(queued, { workspaceId: 'ws', startedAt: 100, startSeq: 40, readCount: 0, total: 17, state: 'queued', error: null, updatedAt: 100 });
  const reading = updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'reading', readCount: 5, now: 110 });
  assert.equal(reading.readCount, 5);
  assert.deepEqual(queueFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', startSeq: 99, total: 1, now: 120 }), reading, 'a restarted generator resumes');
  assert.throws(() => updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', readCount: 4 }), status(400));
  assert.throws(() => updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', readCount: 18 }), status(400));
  assert.throws(() => updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'done' }), status(409));
  assert.throws(() => updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'failed' }), status(400));
  assert.throws(() => updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', error: 'nope' }), status(400));
  const failed = updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'failed', error: ' quota exhausted ', now: 130 });
  assert.equal(failed.error, 'quota exhausted');
  assert.throws(() => updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'reading' }), status(409));
  const retried = queueFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', startSeq: 52, total: 18, now: 140 });
  assert.deepEqual({ state: retried.state, startSeq: retried.startSeq, readCount: retried.readCount, error: retried.error, startedAt: retried.startedAt },
    { state: 'queued', startSeq: 52, readCount: 0, error: null, startedAt: 140 });
  updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'reading', readCount: 18 });
  updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'writing' });
  const done = updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'done', now: 150 });
  assert.equal(done.state, 'done');
  assert.throws(() => updateFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', state: 'writing' }), status(409));
  assert.deepEqual(queueFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', startSeq: 0, total: 0 }), done);
});

test('first-run progress is per owner, never for a system workspace, and follows its workspace', () => {
  queueFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', startSeq: 1, total: 2, now: 1 });
  assert.throws(() => queueFirstRun({ workspaceId: 'ws', ownerUserId: 'bob', startSeq: 1, total: 2 }), status(404));
  assert.throws(() => getFirstRun('ws', 'bob'), status(404));
  assert.deepEqual(listFirstRuns('bob'), []);
  assert.throws(() => updateFirstRun({ workspaceId: 'ws-b', ownerUserId: 'bob', state: 'reading' }), status(404));
  const systemId = getSpacesHome('alice').page.workspaceId;
  assert.throws(() => queueFirstRun({ workspaceId: systemId, ownerUserId: 'alice', startSeq: 0, total: 0 }), status(404));
  assert.throws(() => queueFirstRun({ workspaceId: 'ws', ownerUserId: 'alice', startSeq: -1, total: 0 }), status(400));
  assert.equal(listFirstRuns('alice').length, 1);
  getDb().prepare('UPDATE workspaces SET deleted_at=5 WHERE id=?').run('ws');
  assert.deepEqual(listFirstRuns('alice'), []);
});
