import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { MemoryExtractionStatus } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMemory, setMemorySettings } from '../src/services/memory/memoryService';
import { insertExtractionCursor } from '../src/services/memory/extractionRepository';
import { EXTRACTION_EXCLUSIONS } from '../src/services/memory/extractionPolicy';
import type { MemoryExtractionScheduler } from '../src/services/memory/extractionService';
import { setupMemoryExtractionRoutes } from '../src/routes/memoryExtraction';

let dataDir: string;
let server: ReturnType<typeof express.application.listen>;
let base: string;
let calls: string[];

const fakeScheduler: MemoryExtractionScheduler = {
  createMaintenanceExecution: () => { calls.push('create'); return { id: 'job-x' }; },
  deleteJob: () => { calls.push('delete'); },
  updateJob: (id) => { calls.push(`update:${id}`); return null; },
  cancelActiveRun: (id) => { calls.push(`cancel:${id}`); return false; },
  wakeJobs: () => { calls.push('wake'); },
};

async function start(scheduler: MemoryExtractionScheduler | null): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const owner = req.header('x-user');
    if (owner) req.user = { id: owner, email: `${owner}@example.com` };
    next();
  });
  app.use('/api', setupMemoryExtractionRoutes({ scheduler }));
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

function seedWorkspace(id: string, ownerUserId: string | null): void {
  getDb().prepare("INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Project', ?, 1, 1)").run(id, ownerUserId);
}

function setup(cloud: boolean) {
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-extraction-routes-'));
    process.env.MICHI_DATA_DIR = dataDir;
    if (cloud) process.env.MICHI_CLOUD = '1'; else delete process.env.MICHI_CLOUD;
    calls = [];
    closeDb();
    initDb();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
}

describe('memory extraction routes (local)', () => {
  setup(false);

  test('status has the C5 shape and reports what holds extraction', async (t) => {
    // This route-state test does not depend on the app's first-run runtime choice.
    t.mock.method(require('../src/agents/maintenancePolicy'), 'maintenanceRuntimeAvailability', () => ({ available: true }));
    seedWorkspace('ws', null);
    await start(fakeScheduler);
    const off = await call('GET', '/memory-extraction/status', null);
    assert.equal(off.status, 200);
    const status = off.json as MemoryExtractionStatus;
    for (const key of ['enabled', 'paused', 'lastRunAt', 'lastError', 'pendingCount', 'todayTokens', 'dailyTokenLimit']) {
      assert.ok(key in status, key);
    }
    assert.equal(status.enabled, false);
    assert.equal(status.state, 'off');
    assert.equal(status.supported, true);
    assert.deepEqual(status.exclusions, [...EXTRACTION_EXCLUSIONS]);
    assert.equal(status.dailyTokenLimit, 1_000_000);

    setMemorySettings('local-user', { mode: 'auto' });
    insertExtractionCursor({ workspaceId: 'ws', ownerUserId: 'local-user', cursor: 0, now: 1 });
    const paused = await call('POST', '/memory-extraction/pause', null, {});
    assert.equal(paused.json.paused, true);
    assert.equal(paused.json.state, 'paused');
    const workspacePaused = await call('POST', '/memory-extraction/pause', null, { workspaceId: 'ws' });
    assert.deepEqual(workspacePaused.json.pausedWorkspaceIds, ['ws']);
    const resumed = await call('POST', '/memory-extraction/resume', null);
    assert.equal(resumed.json.paused, false);
    assert.ok(calls.includes('wake'));
    assert.equal((await call('POST', '/memory-extraction/resume', null, { workspaceId: 'ws' })).json.pausedWorkspaceIds.length, 0);
    assert.equal((await call('POST', '/memory-extraction/cancel', null, {})).status, 200);

    assert.equal((await call('POST', '/memory-extraction/pause', null, { workspaceId: 'missing' })).status, 404);
    assert.equal((await call('POST', '/memory-extraction/pause', null, { workspaceId: 'ws', owner: 'bob' })).status, 400);
    assert.equal((await call('POST', '/memory-extraction/pause', null, { workspaceId: 7 })).status, 400);
  });

  test('a backend without the scheduler reports extraction as unsupported, not silently idle', async () => {
    await start(null);
    setMemorySettings('local-user', { mode: 'auto' });
    const status = (await call('GET', '/memory-extraction/status', null)).json as MemoryExtractionStatus;
    assert.equal(status.supported, false);
    assert.equal(status.state, 'unsupported');
    assert.match(status.stateReason ?? '', /local Michi backend/);
  });
});

describe('memory extraction routes (cloud)', () => {
  setup(true);

  test('every route needs an authenticated owner and sees only that owner\'s state', async () => {
    seedWorkspace('ws-alice', 'alice');
    seedWorkspace('ws-bob', 'bob');
    await start(fakeScheduler);
    for (const [method, route] of [['GET', '/memory-extraction/status'], ['POST', '/memory-extraction/pause'], ['POST', '/memory-extraction/resume'], ['POST', '/memory-extraction/cancel']] as const) {
      assert.equal((await call(method, route, null)).status, 401, `${method} ${route}`);
    }
    createMemory({ ownerUserId: 'bob' }, { scope: { kind: 'workspace', workspaceId: 'ws-bob' }, kind: 'fact', body: 'Bob fact', status: 'pending', origin: 'extracted' });
    createMemory({ ownerUserId: 'alice' }, { scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'fact', body: 'Alice fact', status: 'pending', origin: 'extracted' });
    insertExtractionCursor({ workspaceId: 'ws-bob', ownerUserId: 'bob', cursor: 0, now: 1 });
    const alice = (await call('GET', '/memory-extraction/status', 'alice')).json as MemoryExtractionStatus;
    assert.equal(alice.pendingCount, 1);
    assert.equal(alice.supported, false, 'cloud backends do not run background extraction');
    assert.equal((await call('POST', '/memory-extraction/pause', 'alice', { workspaceId: 'ws-bob' })).status, 404);
    assert.equal((await call('POST', '/memory-extraction/pause', 'alice', {})).json.paused, true);
    assert.equal((await call('GET', '/memory-extraction/status', 'bob')).json.paused, false);
  });
});
