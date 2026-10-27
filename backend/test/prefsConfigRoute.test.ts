import { isolatedConfigDir } from './isolatedConfigDir';
import { afterEach, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setupPersistenceRoutes } from '../src/routes/persistence';
import { closeDb } from '../src/services/db';
import { agentConfigEvents, getAgentConfig, updateAgentConfig, updateAgentModelForRuntime } from '../src/services/agentConfig';

const configPath = path.join(isolatedConfigDir, 'config.json');
let dataDir: string;
let originalDataDir: string | undefined;
let originalCloud: string | undefined;
let originalAuth: string | undefined;
let server: ReturnType<express.Express['listen']>;
let base: string;
beforeEach(async () => {
  originalDataDir = process.env.MICHI_DATA_DIR; originalCloud = process.env.MICHI_CLOUD; originalAuth = process.env.MICHI_REQUIRE_AUTH;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-prefs-route-'));
  process.env.MICHI_DATA_DIR = dataDir; delete process.env.MICHI_CLOUD; delete process.env.MICHI_REQUIRE_AUTH;
  closeDb();
  fs.writeFileSync(configPath, JSON.stringify({ agent: { runtime: 'kiro' }, unrelated: { kept: true }, prefs: { uiFont: 'Inter' } }));
  const app = express(); app.use(express.json()); app.use('/api', setupPersistenceRoutes());
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterEach(async () => {
  mock.restoreAll();
  server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); closeDb();
  for (const [key, value] of Object.entries({ MICHI_DATA_DIR: originalDataDir, MICHI_CLOUD: originalCloud, MICHI_REQUIRE_AUTH: originalAuth })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('prefs HTTP refuses corrupt read and write without replacing the file', async () => {
  const corrupt = '{"unrelated":'; fs.writeFileSync(configPath, corrupt);
  for (const method of ['GET', 'PUT']) {
    const result = await fetch(`${base}/prefs`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ uiFont: 'Mono' }) } : {}) });
    assert.equal(result.status, 500); assert.equal((await result.json() as any).ok, undefined);
    assert.equal(fs.readFileSync(configPath, 'utf8'), corrupt);
  }
});

test('prefs HTTP rename failure reports 500 and retains original namespaces', async () => {
  const before = fs.readFileSync(configPath, 'utf8'); const rename = fs.renameSync;
  mock.method(fs, 'renameSync', ((source: any, target: any) => { if (target === configPath) throw new Error('disk write failed'); return rename(source, target); }) as typeof rename);
  const result = await fetch(`${base}/prefs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uiFont: 'Mono' }) });
  assert.equal(result.status, 500); assert.equal((await result.json() as any).ok, undefined);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(isolatedConfigDir), ['config.json']);
});

test('agent model persistence failure retains in-memory config and emits no model change', () => {
  updateAgentConfig({ modelByRuntime: { claude: 'before' } });
  const before = getAgentConfig(); const beforeDisk = fs.readFileSync(configPath, 'utf8'); let emitted = false;
  const listener = () => { emitted = true; }; agentConfigEvents.on('model_changed', listener);
  const rename = fs.renameSync;
  mock.method(fs, 'renameSync', ((source: any, target: any) => { if (target === configPath) throw new Error('rename failed'); return rename(source, target); }) as typeof rename);
  try {
    assert.throws(() => updateAgentModelForRuntime('claude', 'after'));
    assert.equal(getAgentConfig(), before); assert.equal(emitted, false);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeDisk);
  } finally { agentConfigEvents.off('model_changed', listener); }
});
