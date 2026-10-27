import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSystemWorkspaceSettings } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getWorkspace, saveWorkspace } from '../src/services/dbRepository';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { findAssistantWorkspace, isAssistantWorkspace } from '../src/assistant/store';
import { PageWriteError, requirePagesWorkspace } from '../src/services/pages/core';
import {
  createDatabase, createPage, deletePage, getPage, listPages, listSpaces, updatePageMetadata,
} from '../src/services/pages/repository';
import { applyAgentPageEdits, applyUserPageEdits } from '../src/services/pages/pageWrites';
import { listRelevantChanges } from '../src/services/pages/historyRepository';
import { ensurePageHelper } from '../src/services/pages/helpers';
import {
  SPACES_SYSTEM_WORKSPACE, ensureSpacesHomePageId, ensureWorkspaceHomePageId, getSpacesHome, getWorkspaceHome,
  listWorkspaceHomes, setWorkspaceHomeHidden,
} from '../src/services/pages/homePages';
import { setFirstRunWindowDays } from '../src/services/metaAgent/firstRunHistory';
import { queueFirstRun } from '../src/services/pages/firstRun';

const LOCAL = LOCAL_AGENT_OWNER_ID;
let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-spaces-home-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const insert = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,1)');
  insert.run('ws', 'rabbitholes', null, 1);
  insert.run('ws-2', 'sample-notes', null, 2);
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const status = (code: number) => (error: unknown) => error instanceof PageWriteError && error.status === code;
const homeCount = (role: string) => (getDb().prepare('SELECT COUNT(*) AS n FROM pages WHERE role=?').get(role) as { n: number }).n;

test('the local Spaces Home is one page in the assistant workspace, ensured idempotently under concurrent calls', async () => {
  const ids = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => ensureSpacesHomePageId(LOCAL, 10))));
  assert.equal(new Set(ids).size, 1);
  assert.equal(homeCount('spaces-home'), 1);
  const assistant = findAssistantWorkspace();
  assert.ok(assistant);
  const home = getSpacesHome(LOCAL);
  assert.equal(home.page.workspaceId, assistant.id);
  assert.ok(isAssistantWorkspace(home.page.workspaceId));
  assert.equal(home.page.title, 'Home');
  assert.equal(home.page.blocks.length, 1);
  assert.equal(home.page.blocks[0].type, 'home-section');
  assert.deepEqual(home.layoutRules, []);
  // The database refuses a second Spaces Home for the owner, whatever path inserts it.
  assert.throws(() => getDb().prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at,role)
    VALUES ('dup',?,?,'Dup','[]',1,1,'spaces-home')`).run(LOCAL, assistant.id), /UNIQUE constraint failed/);
});

test('the Spaces Home is a real page: user edits apply and leave change records', () => {
  const home = getSpacesHome(LOCAL);
  const result = applyUserPageEdits({ pageId: home.page.id, ownerUserId: LOCAL, revision: home.page.revision, now: 20, ops: [
    { op: 'insert', after: null, block: { type: 'markdown', text: 'My notes' } },
  ] });
  assert.equal(result.applied.length, 1);
  const page = getPage(home.page.id, LOCAL);
  assert.equal(page.blocks.length, 2);
  assert.equal(listRelevantChanges(home.page.id, LOCAL).changes.length, 2);
});

test('the system workspace stays out of Spaces and holds nothing but the Spaces Home', () => {
  const home = getSpacesHome(LOCAL);
  const systemId = home.page.workspaceId;
  createPage({ workspaceId: 'ws', ownerUserId: LOCAL, title: 'Release', now: 5 });
  assert.deepEqual(listSpaces(LOCAL).items.map((space) => space.title), ['Release']);
  assert.ok(isSystemWorkspaceSettings(getWorkspace(systemId)?.settings));
  assert.deepEqual(listPages(systemId, LOCAL).items.map((page) => page.id), [home.page.id]);
  assert.throws(() => createPage({ workspaceId: systemId, ownerUserId: LOCAL, title: 'Sneaky' }), status(404));
  assert.throws(() => createPage({ workspaceId: systemId, ownerUserId: LOCAL, title: 'Child', parentId: home.page.id }), status(404));
  assert.throws(() => createDatabase({ workspaceId: systemId, ownerUserId: LOCAL, title: 'Table' }), status(404));
  assert.throws(() => deletePage(home.page.id, LOCAL), status(409));
  assert.ok(listWorkspaceHomes(LOCAL).every((entry) => entry.workspaceId !== systemId));
});

test('another owner never reaches someone else\'s Spaces Home or its workspace', () => {
  const home = getSpacesHome(LOCAL);
  assert.throws(() => getPage(home.page.id, 'bob'), status(404));
  assert.throws(() => requirePagesWorkspace(home.page.workspaceId, 'bob'), status(404));
  // A system workspace without a Spaces Home is still no Pages workspace.
  getDb().prepare(`INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at,settings) VALUES ('sys2','Other',NULL,1,1,'{"system":"other"}')`).run();
  assert.throws(() => requirePagesWorkspace('sys2', LOCAL), status(404));
});

test('on the desktop a workspace a cloud-mode run left with its own owner id still has the local user\'s home', () => {
  getDb().prepare("INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES ('ws-cloud','sample-planner','cloud-user',3,1)").run();
  const home = getWorkspaceHome('ws-cloud', LOCAL);
  assert.equal(home.page.title, 'sample-planner');
  assert.ok(listWorkspaceHomes(LOCAL).some((entry) => entry.workspaceId === 'ws-cloud' && entry.homePageId === home.page.id));
  // Another signed-in owner still can't reach it, and in cloud mode only its owner can.
  assert.throws(() => getWorkspaceHome('ws-cloud', 'bob'), status(404));
  process.env.MICHI_CLOUD = '1';
  assert.throws(() => getWorkspaceHome('ws-cloud', LOCAL), status(404));
  assert.ok(listWorkspaceHomes(LOCAL).every((entry) => entry.workspaceId !== 'ws-cloud'));
});

test('in cloud mode each owner gets a dedicated hidden spaces workspace that stays marked and comes back from trash', () => {
  process.env.MICHI_CLOUD = '1';
  const alice = getSpacesHome('alice');
  const bob = getSpacesHome('bob');
  assert.notEqual(alice.page.workspaceId, bob.page.workspaceId);
  assert.equal(findAssistantWorkspace(), null);
  const workspace = getWorkspace(alice.page.workspaceId)!;
  assert.equal(workspace.owner_user_id, 'alice');
  assert.equal(JSON.parse(workspace.settings!).system, SPACES_SYSTEM_WORKSPACE);
  assert.ok(isSystemWorkspaceSettings(workspace.settings));
  assert.equal(isAssistantWorkspace(workspace.id), false);
  assert.equal(ensureSpacesHomePageId('alice'), alice.page.id);
  assert.throws(() => getPage(alice.page.id, 'bob'), status(404));

  // A client write cannot unmark it.
  saveWorkspace({ id: workspace.id, name: workspace.name, created_at: workspace.created_at, updated_at: 2,
    owner_user_id: 'alice', settings: JSON.stringify({ theme: 'dark' }) });
  assert.ok(isSystemWorkspaceSettings(getWorkspace(workspace.id)!.settings));

  // A trashed host comes back with the same page on next use.
  getDb().prepare('UPDATE workspaces SET deleted_at=5 WHERE id=?').run(workspace.id);
  assert.equal(ensureSpacesHomePageId('alice'), alice.page.id);
  assert.equal(getWorkspace(workspace.id)!.deleted_at, null);
  assert.deepEqual(listSpaces('alice').items, []);
});

test('a Spaces Home whose host workspace is gone is replaced by one in the current host', () => {
  const first = getSpacesHome(LOCAL);
  getDb().prepare('UPDATE workspaces SET deleted_at=5 WHERE id=?').run(first.page.workspaceId);
  const second = getSpacesHome(LOCAL);
  assert.notEqual(second.page.workspaceId, first.page.workspaceId);
  assert.equal(homeCount('spaces-home'), 1);
});

test('a workspace has at most one home page, ensured on demand and never deleted or moved', async () => {
  const ids = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve().then(() => ensureWorkspaceHomePageId('ws', LOCAL, 10))));
  assert.equal(new Set(ids).size, 1);
  const home = getWorkspaceHome('ws', LOCAL);
  assert.equal(home.page.title, 'rabbitholes');
  assert.equal(home.hiddenAt, null);
  assert.equal(home.firstRun, null);
  assert.throws(() => getDb().prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at,role)
    VALUES ('dup',?,'ws','Dup','[]',1,1,'workspace-home')`).run(LOCAL), /UNIQUE constraint failed/);
  const space = createPage({ workspaceId: 'ws', ownerUserId: LOCAL, title: 'Release' });
  assert.deepEqual(listSpaces(LOCAL).items.map((item) => item.id), [space.id], 'a home page is not a Space');
  assert.throws(() => deletePage(home.page.id, LOCAL), status(409));
  assert.throws(() => updatePageMetadata(home.page.id, LOCAL, { parentId: space.id }, { expectedRevision: home.page.revision }), status(400));
  const renamed = updatePageMetadata(home.page.id, LOCAL, { title: 'Rabbit holes' }, { expectedRevision: home.page.revision });
  assert.equal(renamed.title, 'Rabbit holes');
});

test('a workspace home says how far incremental reading has got and when an agent last changed it', () => {
  const home = getWorkspaceHome('ws', LOCAL, 10);
  assert.equal(home.incremental, null, 'no maintenance consumer yet');
  getDb().prepare(`INSERT INTO scheduled_jobs(id,workspace_id,name,prompt,schedule,created_at,updated_at) VALUES ('job','ws','Meta agent','x','{"kind":"every","everySeconds":60}',1,1)`).run();
  getDb().prepare(`INSERT INTO page_maintenance_configs(workspace_id,owner_user_id,job_id,enabled,completion_cursor,updated_at) VALUES ('ws',?,'job',1,1289,1)`).run(LOCAL);
  applyUserPageEdits({ pageId: home.page.id, ownerUserId: LOCAL, revision: home.page.revision, now: 20, ops: [
    { op: 'insert', after: null, block: { type: 'markdown', text: 'Mine' } },
  ] });
  assert.deepEqual(getWorkspaceHome('ws', LOCAL).incremental, { readThrough: 1289, tidiedAt: null }, 'a person\'s edit is not a tidy-up');
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,title,status) VALUES ('src','ws','chat','Source','idle')").run();
  getDb().prepare("INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES ('t','src','a','active',1,1)").run();
  const page = getPage(home.page.id, LOCAL);
  applyAgentPageEdits({ pageId: page.id, workspaceId: 'ws', ownerUserId: LOCAL, now: 30, source: { kind: 'chat', nodeId: 'src', turnId: 't', assistantId: 'a' },
    ops: [{ op: 'insert', after: page.blocks[0]!.id, block: { type: 'markdown', text: 'Agent' } }] });
  getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=1301').run();
  assert.deepEqual(getWorkspaceHome('ws', LOCAL).incremental, { readThrough: 1301, tidiedAt: 30 });

  // A suggestion on a block the person wrote waits on the home, and the workspace list counts it.
  assert.equal(listWorkspaceHomes(LOCAL).find((entry) => entry.workspaceId === 'ws')?.pendingProposals, 0);
  const mine = getPage(home.page.id, LOCAL).blocks[0]!;
  const proposed = applyAgentPageEdits({ pageId: home.page.id, workspaceId: 'ws', ownerUserId: LOCAL, now: 40, source: { kind: 'chat', nodeId: 'src', turnId: 't', assistantId: 'a' },
    ops: [{ op: 'update', id: mine.id, expectRev: mine.rev, block: { type: 'markdown', text: 'Better' } }] });
  assert.equal(proposed.proposed.length, 1);
  assert.equal(listWorkspaceHomes(LOCAL).find((entry) => entry.workspaceId === 'ws')?.pendingProposals, 1);
  assert.equal(listWorkspaceHomes(LOCAL).find((entry) => entry.workspaceId === 'ws-2')?.pendingProposals, 0);
});

test('workspace summaries distinguish meaningful home content from missing or empty homes', () => {
  const summary = () => listWorkspaceHomes(LOCAL).find((entry) => entry.workspaceId === 'ws')!;
  assert.equal(summary().hasContent, false, 'a workspace without a home is empty');
  const home = getWorkspaceHome('ws', LOCAL);
  assert.equal(summary().hasContent, false, 'creating the home alone does not make content');
  const empty = applyUserPageEdits({ pageId: home.page.id, ownerUserId: LOCAL, revision: home.page.revision, now: 20, ops: [
    { op: 'insert', after: null, block: { type: 'markdown', text: '  \n ' } },
    { op: 'insert', after: null, block: { type: 'checklist', items: [] } },
  ] });
  assert.equal(empty.applied.length, 2);
  assert.equal(summary().hasContent, false, 'blank editor blocks are still empty');
  const page = getPage(home.page.id, LOCAL);
  applyUserPageEdits({ pageId: page.id, ownerUserId: LOCAL, revision: page.revision, now: 30, ops: [
    { op: 'insert', after: null, block: { type: 'markdown', text: 'A useful note from the user' } },
  ] });
  assert.equal(summary().hasContent, true, 'content remains visible regardless of author or first-run state');
  queueFirstRun({ workspaceId: 'ws', ownerUserId: LOCAL, startSeq: 0, total: 2, now: 40 });
  assert.equal(summary().hasContent, true, 'a later queued read cannot hide existing content');
  assert.equal(listWorkspaceHomes(LOCAL).find((entry) => entry.workspaceId === 'ws-2')?.hasContent, false);
});

test('hiding keeps the home page; homes follow their workspace into archive and trash', () => {
  const hidden = setWorkspaceHomeHidden('ws', LOCAL, true, 50);
  assert.equal(hidden.hiddenAt, 50);
  assert.equal(setWorkspaceHomeHidden('ws', LOCAL, true, 60).hiddenAt, 50);
  assert.equal(listWorkspaceHomes(LOCAL).find((entry) => entry.workspaceId === 'ws')?.hiddenAt, 50);
  assert.equal(setWorkspaceHomeHidden('ws', LOCAL, false, 70).hiddenAt, null);

  getDb().prepare('UPDATE workspaces SET archived_at=80 WHERE id IN (?,?)').run('ws', 'ws-2');
  assert.deepEqual(listWorkspaceHomes(LOCAL), []);
  assert.equal(getWorkspaceHome('ws', LOCAL).page.id, hidden.page.id, 'an archived workspace still reads its home');
  assert.throws(() => ensureWorkspaceHomePageId('ws-2', LOCAL), /read-only/);
  assert.throws(() => setWorkspaceHomeHidden('ws', LOCAL, true), /read-only/);

  getDb().prepare('UPDATE workspaces SET archived_at=NULL,deleted_at=90 WHERE id=?').run('ws');
  assert.throws(() => getWorkspaceHome('ws', LOCAL), status(404));
  assert.throws(() => getPage(hidden.page.id, LOCAL), status(404));
  getDb().prepare('UPDATE workspaces SET deleted_at=NULL WHERE id=?').run('ws');
  assert.equal(getWorkspaceHome('ws', LOCAL).page.id, hidden.page.id);
});

test('workspace homes are owner-isolated and never made for a system workspace', () => {
  process.env.MICHI_CLOUD = '1';
  getDb().prepare("UPDATE workspaces SET owner_user_id='alice'").run();
  assert.throws(() => ensureWorkspaceHomePageId('ws', 'bob'), status(404));
  assert.deepEqual(listWorkspaceHomes('bob'), []);
  const systemId = getSpacesHome('alice').page.workspaceId;
  assert.throws(() => ensureWorkspaceHomePageId(systemId, 'alice'), status(404));
  ensureWorkspaceHomePageId('ws', 'alice');
  queueFirstRun({ workspaceId: 'ws-2', ownerUserId: 'alice', startSeq: 3, total: 4, now: 7 });
  assert.deepEqual(listWorkspaceHomes('alice').map((entry) => ({ id: entry.workspaceId, home: entry.homePageId !== null, run: entry.firstRun?.state ?? null })), [
    { id: 'ws', home: true, run: null },
    { id: 'ws-2', home: false, run: 'queued' },
  ]);
});

test('home pages refuse a page helper chat', () => {
  for (const pageId of [ensureSpacesHomePageId(LOCAL), ensureWorkspaceHomePageId('ws', LOCAL)]) {
    assert.throws(() => ensurePageHelper(pageId, LOCAL), (error: unknown) => error instanceof PageWriteError && error.status === 409);
  }
});


test('the workspace home reports the window used by its first read', () => {
  assert.equal(getWorkspaceHome('ws', LOCAL).firstRunDays, null);
  queueFirstRun({ workspaceId: 'ws', ownerUserId: LOCAL, startSeq: 0, total: 0, now: 10 });
  setFirstRunWindowDays('ws', LOCAL, 90);
  assert.equal(getWorkspaceHome('ws', LOCAL).firstRunDays, 90);
});


test('Waiting uses normal page move/delete operations and is never reinserted after deletion', () => {
  let home = getSpacesHome(LOCAL);
  const waiting = home.page.blocks[0];
  applyUserPageEdits({ pageId: home.page.id, ownerUserId: LOCAL, revision: home.page.revision, ops: [
    { op: 'insert', after: waiting.id, block: { type: 'markdown', text: 'Notes' } },
  ] });
  home = getSpacesHome(LOCAL);
  const note = home.page.blocks[1];
  applyUserPageEdits({ pageId: home.page.id, ownerUserId: LOCAL, revision: home.page.revision, ops: [
    { op: 'move', id: waiting.id, after: note.id, expectRev: waiting.rev },
  ] });
  home = getSpacesHome(LOCAL);
  assert.deepEqual(home.page.blocks.map(block => block.id), [note.id, waiting.id]);
  applyUserPageEdits({ pageId: home.page.id, ownerUserId: LOCAL, revision: home.page.revision, ops: [
    { op: 'delete', id: waiting.id, expectRev: home.page.blocks[1].rev },
  ] });
  closeDb(); initDb();
  assert.deepEqual(getSpacesHome(LOCAL).page.blocks.map(block => block.id), [note.id]);
});
