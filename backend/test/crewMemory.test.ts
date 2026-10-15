import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, initDb } from '../src/services/db';
import { saveNode, saveWorkspace, getNode } from '../src/services/dbRepository';
import { defaultCrewMemory, saveDefaultCrewMemory, pinCrewMemory } from '../src/agents/crew/crewMemory';
import { crewRoutes } from '../src/routes/crew';

const saved = { MICHI_DATA_DIR: process.env.MICHI_DATA_DIR, MICHI_CLOUD: process.env.MICHI_CLOUD, MICHI_CREW_MEMORY_MODE: process.env.MICHI_CREW_MEMORY_MODE };
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-crew-memory-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD; delete process.env.MICHI_CREW_MEMORY_MODE;
  closeDb(); initDb();
  saveWorkspace({ id: 'ws', name: 'A', owner_user_id: 'alice', created_at: 1, updated_at: 1 });
  saveNode({ id: 'chat', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1 });
});
afterEach(() => {
  closeDb(); fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('memory defaults persist and graph saves cannot overwrite a native session mode', () => {
  assert.equal(defaultCrewMemory(), 'persistent');
  saveDefaultCrewMemory('temporary'); pinCrewMemory('chat', 'incognito');
  closeDb(); initDb();
  assert.equal(defaultCrewMemory(), 'temporary');
  saveNode({ id: 'chat', workspace_id: 'ws', kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: 1, crew_memory_mode: 'persistent' });
  assert.equal(getNode('chat')?.crew_memory_mode, 'incognito');
});

test('memory API isolates cloud defaults, validates input and hides foreign nodes', async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-test-user']) (req as any).user = { id: req.headers['x-test-user'] }; next(); });
  app.use('/api', crewRoutes());
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/crew/memory`;
  process.env.MICHI_CLOUD = '1';
  const call = (user?: string, mode?: string, node?: string) => fetch(base + (node ? `?nodeId=${node}` : ''), {
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    ...(mode ? { method: 'POST', body: JSON.stringify({ defaultMode: mode }) } : {}),
  });
  try {
    assert.equal((await call()).status, 401);
    assert.equal((await call('alice', 'wrong')).status, 400);
    assert.equal((await call('alice', 'temporary')).status, 200);
    assert.deepEqual(await (await call('alice')).json(), { defaultMode: 'temporary', mode: null });
    assert.deepEqual(await (await call('bob')).json(), { defaultMode: 'persistent', mode: null });
    assert.equal((await call('bob', undefined, 'chat')).status, 404);
    pinCrewMemory('chat', 'incognito');
    assert.deepEqual(await (await call('alice', undefined, 'chat')).json(), { defaultMode: 'temporary', mode: 'incognito' });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
