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

let dataDir: string;
let server: Server | undefined;
let previousDataDir: string | undefined;
let previousCloud: string | undefined;
let baseUrl = '';

beforeEach(async () => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  previousCloud = process.env.MICHI_CLOUD;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pages-routes-'));
  process.env.MICHI_DATA_DIR = dataDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run('ws-a', 'Workspace A', LOCAL_AGENT_OWNER_ID);
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)')
    .run('ws-b', 'Workspace B', LOCAL_AGENT_OWNER_ID);
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, _res, next) => {
    (req as any).user = { id: req.header('x-user-id') ?? LOCAL_AGENT_OWNER_ID, email: 'test@example.test' };
    next();
  });
  app.use('/api', setupPagesRoutes());
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

test('creates, lists, reads, edits and trashes a page with scoped ownership and version polling', async () => {
  const createdResponse = await request('/workspaces/ws-a/pages', { method: 'POST', body: json({ title: 'Release', template: 'blank' }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; revision: number; viewVersion: number; blocks: Array<{ id: string }> };
  assert.ok(created.id);
  assert.equal(created.revision, 1);
  assert.equal(created.blocks.length, 1);

  const listResponse = await request('/workspaces/ws-a/pages');
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json() as { items: Array<{ id: string }> };
  assert.deepEqual(listed.items.map((page) => page.id), [created.id]);

  const unchanged = await request(`/pages/${created.id}?since=${created.viewVersion}`);
  assert.equal(unchanged.status, 204);
  const editedResponse = await request(`/pages/${created.id}/edits`, {
    method: 'POST', body: json({ revision: created.revision, ops: [{ op: 'update', id: created.blocks[0]!.id, block: { type: 'markdown', text: 'Ready' } }] }),
  });
  assert.equal(editedResponse.status, 200);
  const edited = await editedResponse.json() as { page: { revision: number; blocks: Array<{ text: string }> }; changes: { applied: unknown[] } };
  assert.equal(edited.page.revision, 2);
  assert.equal(edited.page.blocks[0]?.text, 'Ready');
  assert.equal(edited.changes.applied.length, 1);
  const changeResponse = await request(`/pages/${created.id}/changes`);
  assert.equal(changeResponse.status, 200);
  const changePage = await changeResponse.json() as { changes: Array<{ seq: number }>; hasMore: boolean };
  assert.equal(changePage.changes.length, 1);
  assert.equal(changePage.hasMore, false);
  const latestChangesResponse = await request(`/pages/${created.id}/changes?direction=backward&limit=100`);
  assert.equal(latestChangesResponse.status, 200);
  const latestChanges = await latestChangesResponse.json() as { changes: Array<{ seq: number }>; nextBefore: number | null };
  assert.equal(latestChanges.changes[0]?.seq, changePage.changes[0]?.seq);
  assert.equal(latestChanges.nextBefore, null);
  assert.equal((await request(`/pages/${created.id}/changes?direction=backward&afterSeq=0`)).status, 400);
  const seenResponse = await request(`/pages/${created.id}/activity-seen`);
  assert.equal((await seenResponse.json() as { lastSeenChangeSeq: number }).lastSeenChangeSeq, 0);
  const acknowledged = await request(`/pages/${created.id}/activity-seen`, {
    method: 'POST', body: json({ lastSeenChangeSeq: changePage.changes[0]!.seq }),
  });
  assert.equal((await acknowledged.json() as { lastSeenChangeSeq: number }).lastSeenChangeSeq, changePage.changes[0]!.seq);

  const wrongOwner = await request(`/pages/${created.id}` , { headers: { 'x-user-id': 'bob' } });
  assert.equal(wrongOwner.status, 404);
  const deleted = await request(`/pages/${created.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const trash = await request('/workspaces/ws-a/pages/trash');
  assert.equal((await trash.json() as { items: Array<{ root: { id: string } }> }).items[0]?.root.id, created.id);
  assert.equal((await request(`/pages/${created.id}`)).status, 404);
  const restored = await request(`/pages/${created.id}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.equal((await request(`/pages/${created.id}`)).status, 200);
  const crossWorkspaceParent = await request('/workspaces/ws-b/pages', { method: 'POST', body: json({ title: 'Wrong parent', parentId: created.id }) });
  assert.equal(crossWorkspaceParent.status, 404);
});

test('creates a native database with server IDs and returns database plus change results on CAS edits', async () => {
  const createdResponse = await request('/workspaces/ws-a/databases', {
    method: 'POST', body: json({ title: 'Tasks', columns: [{ name: 'Task', type: 'text' }], views: [] }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { id: string; revision: number; columns: Array<{ id: string }> };
  assert.equal(created.revision, 1);
  assert.ok(created.columns[0]?.id, 'column ID is assigned by the service');
  assert.equal((await request(`/databases/${created.id}?since=1`)).status, 204);

  const editResponse = await request(`/databases/${created.id}/edits`, {
    method: 'POST', body: json({ revision: 1, ops: [{ op: 'row.add', values: { [created.columns[0]!.id]: 'Ship' } }] }),
  });
  assert.equal(editResponse.status, 200);
  const edited = await editResponse.json() as { database: { revision: number; rows: Array<{ values: Record<string, unknown> }> }; changes: { applied: unknown[]; revision: number } };
  assert.equal(edited.database.revision, 2);
  assert.equal(edited.database.rows[0]?.values[created.columns[0]!.id], 'Ship');
  assert.equal(edited.changes.revision, 2);
  assert.ok(edited.changes.applied.length > 0);

  // The workspace's database list carries each database's row count (the Spaces sidebar shows it).
  const listed = await (await request('/workspaces/ws-a/databases')).json() as { items: Array<{ id: string; rowCount: number }> };
  assert.deepEqual(listed.items.map((item) => [item.id, item.rowCount]), [[created.id, 1]]);
});

test('rejects source/owner injection, stale revisions, malformed queries and oversized edit payloads', async () => {
  const response = await request('/workspaces/ws-a/pages', { method: 'POST', body: json({ title: 'Page', ownerUserId: 'bob' }) });
  assert.equal(response.status, 400);
  const created = await (await request('/workspaces/ws-a/pages', { method: 'POST', body: json({ title: 'Page' }) })).json() as { id: string; revision: number };
  const injected = await request(`/pages/${created.id}/edits`, { method: 'POST', body: json({ revision: 1, ops: [], source: { kind: 'chat', nodeId: 'n', turnId: 't', assistantId: 'a' } }) });
  assert.equal(injected.status, 400);
  const stale = await request(`/pages/${created.id}`, { method: 'PATCH', body: json({ revision: created.revision + 1, title: 'New' }) });
  assert.equal(stale.status, 409);
  assert.equal((await request(`/pages/${created.id}?since=NaN`)).status, 400);
  const tooLarge = await request(`/pages/${created.id}/edits`, { method: 'POST', body: json({ revision: 1, ops: [{ op: 'insert', block: { type: 'markdown', text: 'x'.repeat(1_048_600) } }] }) });
  assert.equal(tooLarge.status, 400);
});


test('a batch can be undone and redone over HTTP, scoped to its owner, and an unknown batch is 404', async () => {
  const created = await (await request('/workspaces/ws-a/databases', {
    method: 'POST', body: json({ title: 'Tasks', columns: [{ name: 'Task', type: 'text' }], views: [] }),
  })).json() as { id: string; columns: Array<{ id: string }> };
  const col = created.columns[0]!.id;
  const edited = await (await request(`/databases/${created.id}/edits`, {
    method: 'POST', body: json({ revision: 1, ops: [{ op: 'row.add', values: { [col]: 'One' } }, { op: 'row.add', values: { [col]: 'Two' } }] }),
  })).json() as { changes: { applied: Array<{ id: string; batchId: string }> } };
  const batchId = edited.changes.applied[0]!.batchId;
  const rows = async () => ((await (await request(`/databases/${created.id}`)).json()) as { rows: Array<{ values: Record<string, unknown> }> }).rows.map((row) => row.values[col]);

  assert.equal((await request(`/page-batches/${batchId}/redo`, { method: 'POST', body: json({}), headers: { 'x-user-id': 'someone-else' } })).status, 404);
  assert.equal((await request(`/page-batches/${batchId}`, { headers: { 'x-user-id': 'someone-else' } })).status, 404);
  assert.equal((await request('/page-batches/no-such-batch')).status, 404);
  const state = async () => await (await request(`/page-batches/${batchId}`)).json();
  assert.deepEqual(await state(), { batchId, applied: 2, reverted: 0 });
  assert.equal((await request('/page-batches/no-such-batch/redo', { method: 'POST', body: json({}) })).status, 404);
  const reverted = await (await request(`/page-batches/${batchId}/revert`, { method: 'POST', body: json({}) })).json() as { reverted: string[] };
  assert.equal(reverted.reverted.length, 2);
  assert.deepEqual(await rows(), []);
  assert.deepEqual(await state(), { batchId, applied: 0, reverted: 2 });
  const redone = await request(`/page-batches/${batchId}/redo`, { method: 'POST', body: json({}) });
  assert.equal(redone.status, 200);
  const answer = await redone.json() as { redone: string[]; conflicts: unknown[] };
  assert.equal(answer.redone.length, 2);
  assert.deepEqual(answer.conflicts, []);
  assert.deepEqual(await rows(), ['One', 'Two']);

  // An archived workspace is read-only: its batch state can still be read, but not changed.
  getDb().prepare("UPDATE workspaces SET archived_at=1 WHERE id='ws-a'").run();
  const archived = await request(`/page-batches/${batchId}`);
  assert.equal(archived.status, 200);
  assert.deepEqual(await archived.json(), { batchId, applied: 2, reverted: 0 });
  assert.equal((await request(`/page-batches/${batchId}/revert`, { method: 'POST', body: json({}) })).status, 409);
});
