import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupAgentRoutes } from '../src/routes/agent';
import { closeDb, initDb } from '../src/services/db';

const originalEnv = { ...process.env };
let directory: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-web-search-routes-'));
  process.env.MICHI_DATA_DIR = directory;
  process.env.MICHI_CLOUD = '1';
  process.env.MICHI_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  closeDb();
  initDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: req.header('x-test-user') ?? 'alice' } });
    next();
  });
  app.use('/api', setupAgentRoutes());
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  process.env = { ...originalEnv };
  fs.rmSync(directory, { recursive: true, force: true });
});

test('search provider selection and key presence are isolated to the signed-in user', async () => {
  const options = await fetch(`${base}/agent/options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webSearchProvider: 'tavily' }),
  });
  assert.equal(options.status, 200);

  const save = await fetch(`${base}/agent/search-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'tavily', key: 'tavily-test-key' }),
  });
  assert.equal(save.status, 200);

  const alice = await (await fetch(`${base}/agent/status`)).json() as {
    webSearchProvider: string | null;
    webSearchProviders: Array<{ id: string; hasKey: boolean }>;
  };
  assert.equal(alice.webSearchProvider, 'tavily');
  assert.equal(alice.webSearchProviders.find((provider) => provider.id === 'tavily')?.hasKey, true);

  const bob = await (await fetch(`${base}/agent/status`, { headers: { 'x-test-user': 'bob' } })).json() as {
    webSearchProvider: string | null;
    webSearchProviders: Array<{ id: string; hasKey: boolean }>;
  };
  assert.equal(bob.webSearchProvider, null);
  assert.equal(bob.webSearchProviders.find((provider) => provider.id === 'tavily')?.hasKey, false);

  const disable = await fetch(`${base}/agent/options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webSearchProvider: null }),
  });
  assert.equal(disable.status, 200);
  const disabled = await (await fetch(`${base}/agent/status`)).json() as { webSearchProvider: string | null };
  assert.equal(disabled.webSearchProvider, null);
});
