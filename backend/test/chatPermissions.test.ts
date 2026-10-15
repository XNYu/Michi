import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, getNode } from '../src/services/dbRepository';
import * as prefsConfig from '../src/services/prefsConfig';
import { readChatPermissionSettings, writeChatPermissionSettings, writeNodePermissionMode, resolveChatPermissionMode, grantChatTool, hasChatToolGrant, chatPermissionResetToken } from '../src/services/chatPermissions';
import { setupPersistenceRoutes } from '../src/routes/persistence';

const originalReadPrefs = prefsConfig.readPrefs;
const originalCloud = process.env.MICHI_CLOUD;
const originalDataDir = process.env.MICHI_DATA_DIR;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-chat-permissions-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  (prefsConfig as any).readPrefs = () => null;
  closeDb(); initDb();
  saveWorkspace({ id: 'ws', name: 'Test', created_at: 1, updated_at: 1 });
  for (const id of ['a', 'b']) saveNode({ id, workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
});
afterEach(() => {
  closeDb(); fs.rmSync(dir, { recursive: true, force: true });
  (prefsConfig as any).readPrefs = originalReadPrefs;
  if (originalCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = originalCloud;
  if (originalDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = originalDataDir;
});

test('defaults to independent Ask chats; legacy bypass migrates to global Trust once', () => {
  (prefsConfig as any).readPrefs = () => ({ bypassPermissions: true });
  assert.deepEqual(readChatPermissionSettings(), { global: true, mode: 'trust' });
  writeChatPermissionSettings({ global: false, mode: 'ask' });
  assert.deepEqual(readChatPermissionSettings(), { global: false, mode: 'ask' });
  assert.equal(resolveChatPermissionMode('a'), 'ask');
});

test('global overrides preserve individual modes across scope changes and database restart', () => {
  writeNodePermissionMode('a', 'trust'); writeNodePermissionMode('b', 'yolo');
  assert.equal(resolveChatPermissionMode('a'), 'trust');
  assert.equal(resolveChatPermissionMode('b'), 'yolo');
  writeChatPermissionSettings({ global: true, mode: 'ask' });
  assert.equal(resolveChatPermissionMode('a'), 'ask');
  assert.equal(resolveChatPermissionMode('b'), 'ask');
  closeDb(); initDb();
  assert.deepEqual(readChatPermissionSettings(), { global: true, mode: 'ask' });
  writeChatPermissionSettings({ global: false, mode: 'ask' });
  assert.equal(resolveChatPermissionMode('a'), 'trust');
  assert.equal(resolveChatPermissionMode('b'), 'yolo');
});

test('first-prompt choice cannot overwrite an existing durable choice on resume', () => {
  writeNodePermissionMode('a', 'trust', null, true);
  writeNodePermissionMode('a', 'yolo', null, true);
  assert.equal(getNode('a')?.permission_mode, 'trust');
  writeNodePermissionMode('a', 'ask');
  assert.equal(resolveChatPermissionMode('a'), 'ask');
  // Delayed graph snapshots omit the server-owned permission column.
  saveNode({ id: 'a', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, permission_mode: 'yolo' });
  assert.equal(getNode('a')?.permission_mode, 'ask');
});

test('resuming an initialized permission choice does not acquire a writer lock', (t) => {
  writeNodePermissionMode('a', 'trust', null, true);
  const db = getDb();
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql: string) => {
    assert.doesNotMatch(sql, /UPDATE nodes SET permission_mode/);
    return prepare(sql);
  });

  writeNodePermissionMode('a', 'yolo', null, true);
  assert.equal(getNode('a')?.permission_mode, 'trust');
});

test('always-allow grants stay in one chat and returning to Ask revokes them', () => {
  grantChatTool('a', 'bash');
  assert.equal(hasChatToolGrant('a', 'bash'), true);
  assert.equal(hasChatToolGrant('b', 'bash'), false);
  writeNodePermissionMode('a', 'trust');
  writeNodePermissionMode('a', 'ask');
  assert.equal(hasChatToolGrant('a', 'bash'), false);
  grantChatTool('a', 'edit'); grantChatTool('b', 'bash');
  writeChatPermissionSettings({ global: true, mode: 'ask' });
  assert.equal(hasChatToolGrant('a', 'edit'), false);
  assert.equal(hasChatToolGrant('b', 'bash'), false);
});

test('permission updates revoke temporary session trust without affecting another owner or chat', () => {
  readChatPermissionSettings();
  const a = chatPermissionResetToken('a'), b = chatPermissionResetToken('b');
  writeNodePermissionMode('a', 'ask');
  assert.notEqual(chatPermissionResetToken('a'), a);
  assert.equal(chatPermissionResetToken('b'), b);
  writeNodePermissionMode('b', 'ask', null, true);
  assert.equal(chatPermissionResetToken('b'), b, 'initialization is not revocation');
  writeChatPermissionSettings({ global: true, mode: 'ask' });
  assert.notEqual(chatPermissionResetToken('b'), b);
  process.env.MICHI_CLOUD = '1';
  const alice = chatPermissionResetToken('a', 'alice'), bob = chatPermissionResetToken('a', 'bob');
  writeChatPermissionSettings({ global: true, mode: 'ask' }, 'alice');
  assert.notEqual(chatPermissionResetToken('a', 'alice'), alice);
  assert.equal(chatPermissionResetToken('a', 'bob'), bob);
});

test('cloud settings and grants are isolated by authenticated owner', () => {
  saveWorkspace({ id: 'ws', name: 'A', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
  saveWorkspace({ id: 'bob-ws', name: 'B', owner_user_id: 'bob', created_at: 1, updated_at: 1 });
  saveNode({ id: 'bob-chat', workspace_id: 'bob-ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
  process.env.MICHI_CLOUD = '1';
  writeChatPermissionSettings({ global: true, mode: 'yolo' }, 'alice');
  assert.equal(resolveChatPermissionMode('a', 'alice'), 'yolo');
  assert.equal(resolveChatPermissionMode('a', 'bob'), 'ask');
  assert.equal(resolveChatPermissionMode('bob-chat', 'bob'), 'ask');
  assert.throws(() => writeNodePermissionMode('a', 'yolo', 'bob'), /not found/);
  grantChatTool('a', 'bash', 'alice'); grantChatTool('bob-chat', 'bash', 'bob');
  writeChatPermissionSettings({ global: true, mode: 'ask' }, 'alice');
  assert.equal(hasChatToolGrant('a', 'bash', 'alice'), false);
  assert.equal(hasChatToolGrant('bob-chat', 'bash', 'bob'), true);
  assert.equal(hasChatToolGrant('bob-chat', 'bash', 'alice'), false);
  assert.throws(() => readChatPermissionSettings(), /authenticated/);
});

test('permission API validates modes, rejects cross-owner writes, and returns authoritative settings', async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-test-user']) (req as any).user = { id: req.headers['x-test-user'] }; next(); });
  app.use('/api', setupPersistenceRoutes());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const put = (url: string, body: unknown, user?: string) => fetch(base + url, { method: 'PUT', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await put('/permissions/settings', { global: true, mode: 'forged' })).status, 400);
    const saved = await put('/permissions/settings', { global: true, mode: 'trust' });
    assert.deepEqual(await saved.json(), { global: true, mode: 'trust' });
    assert.equal((await put('/nodes/a/permissions', { mode: 'forged' })).status, 400);
    assert.equal((await put('/nodes/a/permissions', { mode: 'yolo' })).status, 200);
    saveWorkspace({ id: 'ws', name: 'A', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
    process.env.MICHI_CLOUD = '1';
    assert.equal((await put('/permissions/settings', { global: true, mode: 'yolo' })).status, 401);
    assert.equal((await put('/nodes/a/permissions', { mode: 'yolo' }, 'bob')).status, 404);
    assert.equal((await put('/nodes/a/permissions', { mode: 'ask' }, 'alice')).status, 200);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
