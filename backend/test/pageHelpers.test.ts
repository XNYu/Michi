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
import { createPage, deletePage, purgePageDeletionGroup, restorePageDeletionGroup } from '../src/services/pages/repository';
import { setupPageHelperRoutes } from '../src/routes/pageHelpers';

let dataDir: string;
let previousDataDir: string | undefined;
let previousCloud: string | undefined;
let server: Server | undefined;
let baseUrl = '';

beforeEach(async () => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-page-helpers-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run('ws-a', 'Workspace A', LOCAL_AGENT_OWNER_ID);
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run('ws-b', 'Workspace B', 'bob');
  const app = express();
  app.use((req, _res, next) => {
    (req as typeof req & { user: { id: string; email: string } }).user = { id: req.header('x-user-id') ?? LOCAL_AGENT_OWNER_ID, email: 'test@example.invalid' };
    next();
  });
  app.use('/api', setupPageHelperRoutes());
  server = app.listen(0);
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

async function request(pathname: string, userId?: string): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: userId ? { 'x-user-id': userId } : {} });
}
const helperPath = (pageId: string) => `/pages/${pageId}/helper`;

test('provisions one helper under concurrent requests and returns its persisted identity after restart', async () => {
  const page = createPage({ workspaceId: 'ws-a', ownerUserId: LOCAL_AGENT_OWNER_ID, title: 'Release', now: 10 });
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(helperPath(page.id))));
  for (const response of responses) assert.equal(response.status, 200);
  const descriptors = await Promise.all(responses.map(response => response.json()));
  assert.ok(descriptors.every((item) => JSON.stringify(item) === JSON.stringify(descriptors[0])));
  const descriptor = descriptors[0] as { workspaceId: string; treeId: string; nodeId: string };
  assert.equal(descriptor.workspaceId, 'ws-a');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM nodes WHERE page_id=? AND deleted_at IS NULL AND purged_at IS NULL').get(page.id)?.n, 1);
  assert.equal(getDb().prepare('SELECT helper_node_id FROM pages WHERE id=?').get(page.id)?.helper_node_id, descriptor.nodeId);
  assert.equal(getDb().prepare('SELECT kind,tree_id,status,runtime_id,model_id FROM nodes WHERE id=?').get(descriptor.nodeId)?.kind, 'chat');

  closeDb(); initDb();
  const afterRestart = await request(helperPath(page.id));
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(await afterRestart.json(), descriptor);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM nodes WHERE page_id=? AND deleted_at IS NULL AND purged_at IS NULL').get(page.id)?.n, 1);
});

test('promotion detaches the old chat, preserves its history and next ensure creates a new helper', async () => {
  const page = createPage({ workspaceId: 'ws-a', ownerUserId: LOCAL_AGENT_OWNER_ID, title: 'Notes', now: 20 });
  const first = await (await request(helperPath(page.id))).json() as { workspaceId: string; treeId: string; nodeId: string };
  getDb().prepare("INSERT INTO messages(id,node_id,role,content,seq,created_at) VALUES('history',?,'assistant','Keep me',0,21)").run(first.nodeId);
  const promotedResponse = await request(`${helperPath(page.id)}/promote`);
  assert.equal(promotedResponse.status, 200);
  assert.deepEqual(await promotedResponse.json(), first);
  assert.equal(getDb().prepare('SELECT page_id FROM nodes WHERE id=?').get(first.nodeId)?.page_id, null);
  assert.equal(getDb().prepare('SELECT helper_node_id FROM pages WHERE id=?').get(page.id)?.helper_node_id, null);
  assert.equal(getDb().prepare('SELECT content FROM messages WHERE id=?').get('history')?.content, 'Keep me');
  const second = await (await request(helperPath(page.id))).json() as { workspaceId: string; treeId: string; nodeId: string };
  assert.equal(second.workspaceId, first.workspaceId);
  assert.notEqual(second.nodeId, first.nodeId);
  assert.notEqual(second.treeId, first.treeId);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM nodes WHERE page_id=? AND deleted_at IS NULL AND purged_at IS NULL').get(page.id)?.n, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM nodes WHERE id=?').get(first.nodeId)?.n, 1);
});

test('page trash deletes its helper in the same group, restore reuses it, and purge tombstones it', async () => {
  const page = createPage({ workspaceId: 'ws-a', ownerUserId: LOCAL_AGENT_OWNER_ID, title: 'Trash flow', now: 25 });
  const descriptor = await (await request(helperPath(page.id))).json() as { workspaceId: string; treeId: string; nodeId: string };
  const deletionGroupId = deletePage(page.id, LOCAL_AGENT_OWNER_ID, { now: 26 });
  const trashed = getDb().prepare('SELECT deleted_at,deletion_group_id,page_id FROM nodes WHERE id=?').get(descriptor.nodeId) as {
    deleted_at: number | null; deletion_group_id: string | null; page_id: string | null;
  };
  assert.equal(trashed.deletion_group_id, deletionGroupId);
  assert.ok(trashed.deleted_at !== null);
  assert.equal(trashed.page_id, page.id);
  assert.equal((await request(helperPath(page.id))).status, 404);

  restorePageDeletionGroup(deletionGroupId, LOCAL_AGENT_OWNER_ID, { now: 27 });
  assert.deepEqual(await (await request(helperPath(page.id))).json(), descriptor);
  const secondGroup = deletePage(page.id, LOCAL_AGENT_OWNER_ID, { now: 28 });
  purgePageDeletionGroup(secondGroup, LOCAL_AGENT_OWNER_ID);
  const purged = getDb().prepare('SELECT purged_at FROM nodes WHERE id=?').get(descriptor.nodeId) as { purged_at: number | null };
  assert.ok(purged.purged_at !== null);
});

test('owner isolation, page deletion and archived workspaces reject helper access', async () => {
  const page = createPage({ workspaceId: 'ws-a', ownerUserId: LOCAL_AGENT_OWNER_ID, title: 'Private', now: 30 });
  assert.equal((await request(helperPath(page.id), 'bob')).status, 404);
  assert.equal((await request(helperPath('missing-page'))).status, 404);

  getDb().prepare('UPDATE workspaces SET archived_at=1 WHERE id=?').run('ws-a');
  const archived = await request(helperPath(page.id));
  assert.equal(archived.status, 409);
  getDb().prepare('UPDATE workspaces SET archived_at=NULL WHERE id=?').run('ws-a');

  deletePage(page.id, LOCAL_AGENT_OWNER_ID, { now: 40 });
  assert.equal((await request(helperPath(page.id)).then(response => response.status)), 404);
  const promote = await request(`${helperPath(page.id)}/promote`);
  assert.equal(promote.status, 404);
});
