import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setupPagesRoutes } from '../src/routes/pages';
import { setupSpacesHomeRoutes } from '../src/routes/spacesHome';
import type { HomeLiveWaitReader } from '../src/services/pages/homeSections';
import { seedConversation } from './helpers/homeConversations';

let dataDir: string;
let server: Server | undefined;
let previousDataDir: string | undefined;
let previousCloud: string | undefined;
let baseUrl = '';
let clock = 1_000;
let liveReads: string[] = [];

const liveWait: HomeLiveWaitReader = (nodeId) => {
  liveReads.push(nodeId);
  return nodeId === 'n-run' ? { kind: 'approval', text: 'Run npm test' } : null;
};

beforeEach(async () => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-spaces-home-routes-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  clock = 1_000;
  liveReads = [];
  const insert = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  insert.run('ws-a', 'Workspace A', LOCAL_AGENT_OWNER_ID);
  insert.run('ws-b', 'Workspace B', 'bob');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, _res, next) => {
    (req as any).user = { id: req.header('x-user-id') ?? LOCAL_AGENT_OWNER_ID, email: 'test@example.test' };
    next();
  });
  app.use('/api', setupPagesRoutes());
  app.use('/api', setupSpacesHomeRoutes({ liveWait, clock: () => clock }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  closeDb();
  if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
  if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
}
const json = (value: unknown): string => JSON.stringify(value);

test('concurrent Spaces Home reads converge on one page that the ordinary page routes edit', async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => request('/spaces-home')));
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200, 200]);
  const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ role: string; page: { id: string; revision: number } }>));
  assert.equal(new Set(bodies.map((body) => body.page.id)).size, 1);
  assert.equal(bodies[0]!.role, 'spaces-home');
  const pageId = bodies[0]!.page.id;
  const edited = await request(`/pages/${pageId}/edits`, { method: 'POST', body: json({ revision: bodies[0]!.page.revision, ops: [
    { op: 'insert', after: null, block: { type: 'heading', text: 'This week' } },
  ] }) });
  assert.equal(edited.status, 200);
  assert.equal((await request(`/pages/${pageId}`, { method: 'DELETE' })).status, 409);
  const spaces = await (await request('/spaces')).json() as { items: unknown[] };
  assert.deepEqual(spaces.items, []);
  assert.equal((await request('/spaces-home?x=1')).status, 400);
});

test('workspace homes: ensure, hide, list, validation and owner isolation', async () => {
  process.env.MICHI_CLOUD = '1';
  const home = await request('/workspaces/ws-a/home');
  assert.equal(home.status, 200);
  const body = await home.json() as { role: string; workspaceId: string; page: { id: string; title: string }; hiddenAt: number | null };
  assert.deepEqual([body.role, body.workspaceId, body.page.title, body.hiddenAt], ['workspace-home', 'ws-a', 'Workspace A', null]);
  clock = 2_000;
  const hidden = await request('/workspaces/ws-a/home', { method: 'PATCH', body: json({ hidden: true }) });
  assert.equal(((await hidden.json()) as { hiddenAt: number }).hiddenAt, 2_000);
  assert.equal((await request('/workspaces/ws-a/home', { method: 'PATCH', body: json({ hidden: 'yes' }) })).status, 400);
  assert.equal((await request('/workspaces/ws-a/home', { method: 'PATCH', body: json({ hidden: true, extra: 1 }) })).status, 400);
  const list = await (await request('/spaces-home/workspaces')).json() as { items: Array<{ workspaceId: string; homePageId: string | null; hiddenAt: number | null }> };
  assert.deepEqual(list.items, [{ workspaceId: 'ws-a', workspaceName: 'Workspace A', homePageId: body.page.id, hasContent: false, hiddenAt: 2_000, firstRun: null, pendingProposals: 0 }]);
  const missing = await request('/workspaces/ws-b/home');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: 'not_found', message: 'Workspace not found' } });
});

test('layout rule routes add, list and delete; user-direct rules are marked as the user\'s', async () => {
  const { page } = await (await request('/spaces-home')).json() as { page: { id: string } };
  clock = 3_000;
  const created = await request(`/pages/${page.id}/layout-rules`, { method: 'POST', body: json({ text: 'Stalled lists only 3 days' }) });
  assert.equal(created.status, 201);
  const rule = await created.json() as { id: string; createdBy: string; createdAt: number; sourceMessage: unknown };
  assert.deepEqual([rule.createdBy, rule.createdAt, rule.sourceMessage], ['user', 3_000, null]);
  assert.equal((await request(`/pages/${page.id}/layout-rules`, { method: 'POST', body: json({ text: 'x', createdBy: 'agent' }) })).status, 400);
  assert.equal((await request(`/pages/${page.id}/layout-rules`, { method: 'POST', body: json({ text: '' }) })).status, 400);
  const limited = await request(`/pages/${page.id}/layout-rules`, { method: 'POST', body: json({ text: 'Done: 2', sectionLimit: { section: 'done', maxItems: 2 } }) });
  assert.equal(limited.status, 201);
  const limitedRule = await limited.json() as { id: string; sectionLimit: unknown };
  assert.deepEqual(limitedRule.sectionLimit, { section: 'done', maxItems: 2 });
  assert.equal((await request(`/pages/${page.id}/layout-rules`, { method: 'POST', body: json({ text: 'x', sectionLimit: { section: 'done' } }) })).status, 400);
  await request(`/pages/${page.id}/layout-rules/${limitedRule.id}`, { method: 'DELETE' });
  const listed = await (await request(`/pages/${page.id}/layout-rules`)).json() as { items: Array<{ id: string }> };
  assert.deepEqual(listed.items.map((item) => item.id), [rule.id]);
  const deleted = await request(`/pages/${page.id}/layout-rules/${rule.id}`, { method: 'DELETE' });
  assert.deepEqual(await deleted.json(), { items: [] });
  assert.equal((await request(`/pages/${page.id}/layout-rules/${rule.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await request(`/pages/${page.id}/layout-rules`, { headers: { 'x-user-id': 'bob' } })).status, 404);
});

test('layout preferences routes use exact revisions, user attribution and page ownership', async () => {
  const { page } = await (await request('/workspaces/ws-a/home')).json() as { page: { id: string } };
  const pathname = `/pages/${page.id}/layout-preferences`;
  assert.deepEqual(await (await request(pathname)).json(), { text: '', revision: 0, updatedAt: null, updatedBy: null });
  const saved = await request(pathname, { method: 'PUT', body: json({ text: ' Put risks first ', expectedRevision: 0 }) });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { text: 'Put risks first', revision: 1, updatedAt: clock, updatedBy: 'user' });
  const stale = await request(pathname, { method: 'PUT', body: json({ text: 'Old draft', expectedRevision: 0 }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as any).error.code, 'stale_revision');
  for (const payload of [{ text: 'No revision' }, { text: 'Forged actor', expectedRevision: 1, actor: 'agent' }]) {
    assert.equal((await request(pathname, { method: 'PUT', body: json(payload) })).status, 400);
  }
  assert.equal((await request(pathname, { headers: { 'x-user-id': 'bob' } })).status, 404);
  assert.equal((await request(pathname, { method: 'PUT', headers: { 'x-user-id': 'bob' }, body: json({ text: 'Other owner', expectedRevision: 1 }) })).status, 404);
  getDb().prepare('UPDATE workspaces SET archived_at=10 WHERE id=?').run('ws-a');
  assert.equal((await request(pathname)).status, 200);
  assert.equal((await request(pathname, { method: 'PUT', body: json({ text: 'Archived write', expectedRevision: 1 }) })).status, 409);
  getDb().prepare('UPDATE pages SET deleted_at=20 WHERE id=?').run(page.id);
  assert.equal((await request(pathname)).status, 404);
});

test('progress card routes create, list per page and for Home, mark seen and dismiss', async () => {
  const { page } = await (await request('/workspaces/ws-a/home')).json() as { page: { id: string } };
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,title,status) VALUES ('n1','ws-a','chat','Rollback run','idle')").run();
  const created = await request('/progress-cards', { method: 'POST', body: json({ threadNodeId: 'n1', startedFromPageId: page.id }) });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { status: string }).status, 'idle');
  assert.equal((await request('/progress-cards', { method: 'POST', body: json({ threadNodeId: 'n1' }) })).status, 400);
  const onPage = await (await request(`/pages/${page.id}/progress-cards`)).json() as { items: Array<{ threadNodeId: string }> };
  assert.deepEqual(onPage.items.map((card) => card.threadNodeId), ['n1']);
  clock = 10_000;
  const seen = await (await request('/progress-cards/n1/seen', { method: 'POST' })).json() as { seenAt: number; expiresAt: number };
  assert.deepEqual([seen.seenAt, seen.expiresAt], [10_000, 10_000 + 24 * 60 * 60 * 1000]);
  clock = 10_000 + 24 * 60 * 60 * 1000;
  assert.deepEqual(((await (await request('/spaces-home/progress-cards')).json()) as { items: unknown[] }).items, []);
  assert.equal(((await (await request('/progress-cards/n1/dismiss', { method: 'POST' })).json()) as { dismissedAt: number }).dismissedAt, clock);
  assert.equal((await request('/progress-cards/n1/seen', { method: 'POST', headers: { 'x-user-id': 'bob' } })).status, 404);
});

test('sections and All threads count Michi conversations; a running turn asks ChatHub; validation', async () => {
  process.env.MICHI_CLOUD = '1';
  clock = 10 * 24 * 60 * 60 * 1000;
  seedConversation({ nodeId: 'n-run', workspaceId: 'ws-a', title: 'Run the suite', turns: [{ status: 'active', startedAt: clock - 1_000 }] });
  seedConversation({ nodeId: 'n-ask', workspaceId: 'ws-a', title: 'Pick a tier', turns: [{ status: 'completed', startedAt: clock - 2_000, reply: 'Which tier?' }] });
  seedConversation({ nodeId: 'n-bob', workspaceId: 'ws-b', turns: [{ status: 'error', startedAt: clock - 3_000, error: 'boom' }] });
  const sections = await (await request('/spaces-home/sections')).json() as {
    waiting: { total: number; items: Array<{ id: string; summary: string }> }; conversations: unknown; conversationTotal: number;
    byWorkspace: Record<string, { waiting: number; stalled: number }>;
  };
  assert.deepEqual(liveReads, ['n-run']);
  assert.deepEqual(sections.conversations, { available: true });
  assert.deepEqual(sections.waiting.items.map((item) => [item.id, item.summary]), [
    ['conversation:n-run', 'Waiting for your approval: Run npm test'], ['conversation:n-ask', 'Asked: Which tier?'],
  ]);
  assert.equal(sections.conversationTotal, 2);
  assert.deepEqual(sections.byWorkspace, { 'ws-a': { waiting: 2, stalled: 0 } });

  const all = await (await request('/spaces-home/conversations')).json() as { total: number; items: Array<{ id: string; state: string | null }> };
  assert.deepEqual([all.total, all.items.map((item) => item.state)], [2, ['waiting', 'waiting']]);
  const one = await (await request('/spaces-home/conversations?state=waiting&limit=1')).json() as { total: number; items: unknown[] };
  assert.deepEqual([one.total, one.items.length], [2, 1]);
  assert.equal(((await (await request('/spaces-home/conversations?state=waiting', { headers: { 'x-user-id': 'bob' } })).json()) as { total: number }).total, 1);
  for (const bad of ['state=busy', 'limit=0', 'limit=501', 'limit=x', 'other=1']) {
    assert.equal((await request(`/spaces-home/conversations?${bad}`)).status, 400, bad);
  }
  assert.equal((await request('/spaces-home/sections?since=soon')).status, 400);
  assert.equal((await request('/spaces-home/activity?limit=-1')).status, 400);
  assert.deepEqual(await (await request('/spaces-home/activity?limit=5')).json(), { items: [] });
});

test('the Spaces Home look is recorded per owner and starts Just done', async () => {
  const day = 24 * 60 * 60 * 1000;
  clock = 10 * day;
  assert.deepEqual(await (await request('/spaces-home/look')).json(), { lookedAt: null });
  seedConversation({ nodeId: 'n-done', workspaceId: 'ws-a', turns: [{ status: 'completed', startedAt: clock - 5_000, completedAt: clock - 4_000, reply: 'Shipped it.\nDetails' }] });
  const before = await (await request('/spaces-home/sections')).json() as { done: { items: Array<{ summary: string }> }; doneSince: number };
  assert.deepEqual([before.done.items.map((item) => item.summary), before.doneSince], [['Shipped it.'], clock - day]);
  assert.deepEqual(await (await request('/spaces-home/look', { method: 'POST' })).json(), { lookedAt: clock });
  assert.equal((await request('/spaces-home/look', { method: 'POST', body: json({ at: 1 }) })).status, 400);
  assert.deepEqual(await (await request('/spaces-home/look')).json(), { lookedAt: clock });
  assert.deepEqual(await (await request('/spaces-home/look', { headers: { 'x-user-id': 'bob' } })).json(), { lookedAt: null });
  const after = await (await request('/spaces-home/sections')).json() as { done: { total: number }; doneSince: number };
  assert.deepEqual([after.done.total, after.doneSince], [0, clock]);
});

test('in cloud mode every owner has a separate Spaces Home', async () => {
  process.env.MICHI_CLOUD = '1';
  const alice = await (await request('/spaces-home', { headers: { 'x-user-id': 'alice' } })).json() as { page: { id: string } };
  const bob = await (await request('/spaces-home', { headers: { 'x-user-id': 'bob' } })).json() as { page: { id: string } };
  assert.notEqual(alice.page.id, bob.page.id);
  assert.equal((await request(`/pages/${alice.page.id}`, { headers: { 'x-user-id': 'bob' } })).status, 404);
  const bobHome = await request('/workspaces/ws-b/home', { headers: { 'x-user-id': 'bob' } });
  assert.equal(bobHome.status, 200);
  assert.equal((await request('/workspaces/ws-b/home', { headers: { 'x-user-id': 'alice' } })).status, 404);
});

test('desktop home routes include workspaces and conversations with legacy owners', async () => {
  assert.equal((await request('/workspaces/ws-b/home')).status, 200);
  const homes = await (await request('/spaces-home/workspaces')).json() as { items: Array<{ workspaceId: string }> };
  assert.deepEqual(homes.items.map(item => item.workspaceId), ['ws-a', 'ws-b']);
  seedConversation({ nodeId: 'legacy-chat', workspaceId: 'ws-b', turns: [{ status: 'completed', startedAt: clock - 100, completedAt: clock - 50, reply: 'Finished.' }] });
  const conversations = await (await request('/spaces-home/conversations')).json() as { total: number; items: Array<{ id: string }> };
  assert.equal(conversations.total, 1);
  assert.deepEqual(conversations.items.map(item => item.id), ['conversation:legacy-chat']);
});

test('reminder writes reject stale requests and update counts', async () => {
  let response: Response;
  seedConversation({ nodeId: 'reminder', workspaceId: 'ws-a', turns: [{ status: 'error', startedAt: 100, completedAt: 200, error: 'Failed' }] });
  const item = (await (await request('/spaces-home/sections')).json() as any).waiting.items[0];
  response = await request('/spaces-home/reminders', { method: 'POST', body: JSON.stringify({ itemId: item.id, version: 'old', action: 'dismiss' }) });
  assert.equal(response.status, 409);
  response = await request('/spaces-home/reminders', { method: 'POST', body: JSON.stringify({ itemId: item.id, version: item.reminderVersion, action: 'dismiss' }) });
  assert.equal(response.status, 200);
  assert.equal((await (await request('/spaces-home/sections')).json() as any).waiting.total, 0);
});
