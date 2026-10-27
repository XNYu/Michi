import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { threadStates } from '../src/services/pages/homeSections';
import { setupSpacesHomeRoutes } from '../src/routes/spacesHome';
import { seedConversation } from './helpers/homeConversations';

const OWNER = LOCAL_AGENT_OWNER_ID;
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
let dir: string;
let oldData: string | undefined;
let oldCloud: string | undefined;

beforeEach(() => {
  oldData = process.env.MICHI_DATA_DIR;
  oldCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-thread-states-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  workspace.run('ws', 'rabbitholes', null);
  workspace.run('other', 'Elsewhere', null);
  seedConversation({ nodeId: 'asked', workspaceId: 'ws', title: 'Schema naming', turns: [{ status: 'completed', startedAt: NOW - DAY, reply: 'camelCase or snake_case?' }] });
  seedConversation({ nodeId: 'running', workspaceId: 'ws', title: 'Tests', turns: [{ status: 'active', startedAt: NOW - 60_000, reply: 'Running the suites' }] });
  seedConversation({ nodeId: 'gone', workspaceId: 'ws', title: 'Deleted', deletedAt: NOW, turns: [{ status: 'completed', startedAt: NOW - DAY }] });
  seedConversation({ nodeId: 'moved', workspaceId: 'other', title: 'Moved away', turns: [{ status: 'completed', startedAt: NOW - DAY, reply: 'Done.' }] });
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('thread states read each named conversation wherever it is, and leave out deleted ones', () => {
  const states = Object.fromEntries(threadStates({ ownerUserId: OWNER, nodeIds: ['asked', 'running', 'moved', 'gone', 'nope'], now: NOW })
    .map((card) => [card.nodeId, [card.state, card.workspaceId]]));
  assert.deepEqual(states, { asked: ['waiting', 'ws'], running: ['running', 'ws'], moved: ['done', 'other'] });
  assert.deepEqual(threadStates({ ownerUserId: OWNER, nodeIds: [], now: NOW }), []);
});

test('the thread states route takes up to 500 distinct ids, and the conversation list filters by workspace', async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', setupSpacesHomeRoutes({ clock: () => NOW }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spaces-home`;
  const post = (body: unknown) => fetch(`${base}/thread-states`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const listed = await (await post({ nodeIds: ['asked', 'moved'] })).json() as { items: Array<{ nodeId: string }> };
    assert.deepEqual(listed.items.map((item) => item.nodeId).sort(), ['asked', 'moved']);
    assert.equal((await post({ nodeIds: Array.from({ length: 501 }, (_, index) => `n${index}`) })).status, 400);
    assert.equal((await post({ nodeIds: ['asked', 'asked'] })).status, 400);
    assert.equal((await post({ nodeIds: 'asked' })).status, 400);
    assert.equal((await post({ nodeIds: ['asked'], workspaceId: 'ws' })).status, 400);
    const other = await (await fetch(`${base}/conversations?workspaceId=other`)).json() as { items: Array<{ title: string }> };
    assert.deepEqual(other.items.map((item) => item.title), ['Moved away']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
