import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { MemoryRecord } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMemory } from '../src/services/memory/memoryService';
import { setupMemoryRoutes } from '../src/routes/memories';

let dataDir: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;

async function start(): Promise<void> {
  const app = express();
  app.use(express.json());
  // Stands in for the session gate: the authenticated user, when there is one.
  app.use((req, _res, next) => {
    const owner = req.header('x-user');
    if (owner) req.user = { id: owner, email: `${owner}@example.com` };
    next();
  });
  app.use('/api', setupMemoryRoutes());
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function call(method: string, route: string, owner: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(owner ? { 'x-user': owner } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function seedWorkspace(id: string, ownerUserId: string): void {
  getDb().prepare("INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Project', ?, 1, 1)")
    .run(id, ownerUserId);
}

function storedCount(): number {
  return (getDb().prepare('SELECT count(*) AS n FROM memories').get() as { n: number }).n;
}

function pending(ownerUserId: string, body: string): MemoryRecord {
  return createMemory({ ownerUserId }, { scope: { kind: 'user' }, kind: 'fact', body, status: 'pending', origin: 'extracted' });
}

describe('memory routes (cloud)', () => {
  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-routes-'));
    process.env.MICHI_DATA_DIR = dataDir;
    process.env.MICHI_CLOUD = '1';
    closeDb();
    initDb();
    seedWorkspace('ws-alice', 'alice');
    seedWorkspace('ws-bob', 'bob');
    await start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('every route needs an authenticated owner', async () => {
    const requests: Array<[string, string, unknown?]> = [
      ['GET', '/memories'],
      ['POST', '/memories', { scope: { kind: 'user' }, kind: 'fact', body: 'x' }],
      ['PATCH', '/memories/mem-1', { body: 'x', expectedVersion: 1 }],
      ['DELETE', '/memories/mem-1'],
      ['POST', '/memories/mem-1/approve'],
      ['POST', '/memories/mem-1/reject'],
      ['GET', '/memory-settings'],
      ['PUT', '/memory-settings', { mode: 'off' }],
    ];
    for (const [method, route, body] of requests) {
      const response = await call(method, route, null, body);
      assert.equal(response.status, 401, `${method} ${route}`);
    }
    assert.equal(storedCount(), 0);
  });

  test('creates explicit active memories and lists them by scope', async () => {
    const created = await call('POST', '/memories', 'alice', { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'convention', body: ' use 2 spaces ' });
    assert.equal(created.status, 201);
    assert.equal(created.json.memory.body, 'use 2 spaces');
    assert.equal(created.json.memory.origin, 'explicit');
    assert.equal(created.json.memory.status, 'active');
    assert.equal(created.json.memory.ownerUserId, 'alice');
    await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'preference', body: '回答用中文' });

    const all = await call('GET', '/memories', 'alice');
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((item: MemoryRecord) => item.body), ['回答用中文', 'use 2 spaces']);
    assert.equal(all.json.nextCursor, null);
    const workspace = await call('GET', '/memories?scope=workspace&workspaceId=ws-alice', 'alice');
    assert.deepEqual(workspace.json.items.map((item: MemoryRecord) => item.body), ['use 2 spaces']);
    const user = await call('GET', '/memories?scope=user', 'alice');
    assert.deepEqual(user.json.items.map((item: MemoryRecord) => item.body), ['回答用中文']);
    const searched = await call('GET', `/memories?q=${encodeURIComponent('中文')}`, 'alice');
    assert.deepEqual(searched.json.items.map((item: MemoryRecord) => item.body), ['回答用中文']);
    const paged = await call('GET', '/memories?limit=1', 'alice');
    assert.equal(paged.json.items.length, 1);
    const next = await call('GET', `/memories?limit=1&cursor=${encodeURIComponent(paged.json.nextCursor)}`, 'alice');
    assert.deepEqual(next.json.items.map((item: MemoryRecord) => item.body), ['use 2 spaces']);

    assert.deepEqual((await call('GET', '/memories', 'bob')).json.items, []);
  });

  test('rejects fields that would choose origin, status, owner or source, and malformed queries', async () => {
    for (const extra of [{ origin: 'extracted' }, { status: 'pending' }, { ownerUserId: 'bob' }, { source: { nodeId: 'n' } }]) {
      const response = await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'x', ...extra });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.equal(response.json.code, 'invalid_argument');
    }
    assert.equal((await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'rumor', body: 'x' })).status, 400);
    assert.equal((await call('GET', '/memories?scope=global', 'alice')).status, 400);
    assert.equal((await call('GET', '/memories?limit=-1', 'alice')).status, 400);
    assert.equal((await call('GET', '/memories?status=deleted', 'alice')).status, 400);
    assert.equal((await call('GET', '/memories?cursor=bogus', 'alice')).status, 400);
    assert.equal(storedCount(), 0);
  });

  test("another owner's memory or workspace answers 404, like a missing one", async () => {
    const own = (await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'alice fact' })).json.memory as MemoryRecord;
    const waiting = pending('alice', 'alice pending');
    const attempts: Array<[string, string, unknown?]> = [
      ['PATCH', `/memories/${own.id}`, { body: 'stolen', expectedVersion: 1 }],
      ['DELETE', `/memories/${own.id}`],
      ['POST', `/memories/${waiting.id}/approve`],
      ['POST', `/memories/${waiting.id}/reject`],
      ['GET', '/memories?workspaceId=ws-alice'],
      ['POST', '/memories', { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'fact', body: 'x' }],
    ];
    for (const [method, route, body] of attempts) {
      const response = await call(method, route, 'bob', body);
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.equal(response.json.code, 'not_found');
    }
    assert.equal((await call('PATCH', '/memories/mem-missing', 'alice', { body: 'x', expectedVersion: 1 })).status, 404);
    assert.equal((await call('DELETE', '/memories/mem-missing', 'alice')).status, 404);
    const stored = (await call('GET', '/memories', 'alice')).json.items.map((item: MemoryRecord) => item.body);
    assert.deepEqual(stored, ['alice pending', 'alice fact']);
  });

  test('a stale expectedVersion answers 409 version_conflict with the current version', async () => {
    const created = (await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'v1' })).json.memory as MemoryRecord;
    const edited = await call('PATCH', `/memories/${created.id}`, 'alice', { body: 'v2', expectedVersion: 1 });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.memory.version, 2);
    const stale = await call('PATCH', `/memories/${created.id}`, 'alice', { body: 'v3', expectedVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'version_conflict');
    assert.equal(stale.json.currentVersion, 2);
    assert.equal((await call('PATCH', `/memories/${created.id}`, 'alice', { body: 'v3' })).status, 400);
    const moved = await call('PATCH', `/memories/${created.id}`, 'alice', { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, expectedVersion: 2 });
    assert.deepEqual(moved.json.memory.scope, { kind: 'workspace', workspaceId: 'ws-alice' });
  });

  test('approve, reject and delete', async () => {
    const approveMe = pending('alice', 'approve me');
    const rejectMe = pending('alice', 'reject me');
    const approved = await call('POST', `/memories/${approveMe.id}/approve`, 'alice');
    assert.equal(approved.status, 200);
    assert.equal(approved.json.memory.status, 'active');
    assert.equal((await call('POST', `/memories/${approveMe.id}/approve`, 'alice')).json.code, 'invalid_state');
    assert.equal((await call('POST', `/memories/${rejectMe.id}/reject`, 'alice')).status, 204);
    assert.equal((await call('POST', `/memories/${approveMe.id}/reject`, 'alice')).status, 409);
    assert.equal((await call('DELETE', `/memories/${approveMe.id}`, 'alice')).status, 204);
    assert.deepEqual((await call('GET', '/memories?status=active,pending,superseded', 'alice')).json.items, []);
    assert.equal((await call('DELETE', `/memories/${approveMe.id}`, 'alice')).status, 404);
  });

  test('memory settings default to explicit; off refuses new memories but keeps management', async () => {
    assert.deepEqual((await call('GET', '/memory-settings', 'alice')).json, { mode: 'explicit' });
    const kept = (await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'kept' })).json.memory as MemoryRecord;
    const off = await call('PUT', '/memory-settings', 'alice', { mode: 'off' });
    assert.equal(off.status, 200);
    assert.deepEqual(off.json, { mode: 'off' });
    assert.deepEqual((await call('GET', '/memory-settings', 'bob')).json, { mode: 'explicit' });

    const refused = await call('POST', '/memories', 'alice', { scope: { kind: 'user' }, kind: 'fact', body: 'new' });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'memory_disabled');
    assert.equal((await call('GET', '/memories?q=kept', 'alice')).json.items.length, 1);
    assert.equal((await call('DELETE', `/memories/${kept.id}`, 'alice')).status, 204);

    assert.equal((await call('PUT', '/memory-settings', 'alice', { mode: 'sometimes' })).status, 400);
    assert.equal((await call('PUT', '/memory-settings', 'alice', { mode: 'auto', ownerUserId: 'bob' })).status, 400);
    assert.deepEqual((await call('GET', '/memory-settings', 'alice')).json, { mode: 'off' });
  });
});

describe('memory routes (desktop)', () => {
  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-routes-'));
    process.env.MICHI_DATA_DIR = dataDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-local', 'Local', 1, 1)").run();
    await start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('requests act as the local user, whatever user they carry', async () => {
    const created = await call('POST', '/memories', null, { scope: { kind: 'workspace', workspaceId: 'ws-local' }, kind: 'fact', body: 'local note' });
    assert.equal(created.status, 201);
    assert.equal(created.json.memory.ownerUserId, 'local-user');
    assert.deepEqual((await call('GET', '/memories', 'someone-else')).json.items.map((item: MemoryRecord) => item.body), ['local note']);
  });
});
