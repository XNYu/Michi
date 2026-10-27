import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { closeDb, getDb, initDb } from '../src/services/db';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { threadCards } from '../src/services/pages/homeSections';
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-home-thread-cards-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  const workspace = getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,1,1)');
  workspace.run('ws', 'rabbitholes', null);
  workspace.run('other', 'Elsewhere', null);
  seedConversation({ nodeId: 'asked', workspaceId: 'ws', title: 'Schema naming', turns: [{ status: 'completed', startedAt: NOW - DAY, reply: 'camelCase or snake_case?' }] });
  seedConversation({ nodeId: 'quiet', workspaceId: 'ws', title: 'Migration', turns: [{ status: 'completed', startedAt: NOW - 9 * DAY, reply: 'Half the scripts run.\nThe rest next.' }] });
  seedConversation({ nodeId: 'running', workspaceId: 'ws', title: 'Tests', turns: [{ status: 'active', startedAt: NOW - 60_000, reply: 'Running the suites' }] });
  seedConversation({ nodeId: 'failed', workspaceId: 'ws', title: 'Docs', turns: [{ status: 'error', startedAt: NOW - 5 * DAY, error: 'Provider timed out' }] });
  seedConversation({ nodeId: 'stopped', workspaceId: 'ws', title: 'Release', turns: [{ status: 'cancelled', startedAt: NOW - DAY, reply: 'Drafting the' }] });
  seedConversation({ nodeId: 'fresh', workspaceId: 'ws', title: 'Not started' });
  seedConversation({ nodeId: 'archived', workspaceId: 'ws', title: 'Old', nodeStatus: 'archived', turns: [{ status: 'completed', startedAt: NOW - 30 * DAY, reply: 'Wrapped up.' }] });
  seedConversation({ nodeId: 'scheduled', workspaceId: 'ws', title: 'Nightly', turns: [{ status: 'completed', startedAt: NOW - DAY, reply: 'All green.', scheduledJobId: 'job-1' }] });
  seedConversation({ nodeId: 'gone', workspaceId: 'ws', title: 'Deleted', deletedAt: NOW, turns: [{ status: 'completed', startedAt: NOW - DAY }] });
  seedConversation({ nodeId: 'moved', workspaceId: 'other', title: 'Moved away', turns: [{ status: 'completed', startedAt: NOW - DAY, reply: 'Done.' }] });
});

afterEach(() => {
  closeDb();
  if (oldData === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = oldData;
  if (oldCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = oldCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

const cards = (nodeIds: string[], workspaceId = 'ws') => Object.fromEntries(threadCards({ ownerUserId: OWNER, workspaceId, nodeIds, now: NOW })
  .map((card) => [card.nodeId, [card.state, card.summary]]));

test('a thread card shows where its conversation stands now, whatever the person has seen', () => {
  assert.deepEqual(cards(['asked', 'quiet', 'running', 'failed', 'stopped', 'fresh']), {
    asked: ['waiting', 'Asked: camelCase or snake_case?'],
    quiet: ['done', 'Half the scripts run.'],
    running: ['running', 'Running the suites'],
    failed: ['stalled', 'Failed: Provider timed out'],
    stopped: ['done', 'Stopped before it finished'],
    fresh: ['idle', ''],
  });
});

test('cards show archived and scheduled conversations, and leave out ones deleted or moved to another workspace', () => {
  assert.deepEqual(Object.keys(cards(['archived', 'scheduled', 'gone', 'moved'])).sort(), ['archived', 'scheduled']);
  assert.deepEqual(Object.keys(cards(['moved'], 'other')), ['moved']);
  assert.deepEqual(cards([]), {});
});

test('the thread cards route takes the page workspace and a bounded nodeIds list', async () => {
  const app = express();
  app.use('/api', setupSpacesHomeRoutes({ clock: () => NOW }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spaces-home/thread-cards`;
  try {
    const listed = await (await fetch(`${base}?workspaceId=ws&nodeIds=asked,moved`)).json() as { items: Array<{ title: string; messageId: string | null }> };
    assert.deepEqual(listed.items.map((item) => [item.title, item.messageId]), [['Schema naming', 'asked-t0-a']]);
    const many = Array.from({ length: 21 }, (_, index) => `n${index}`).join(',');
    assert.equal((await fetch(`${base}?workspaceId=ws&nodeIds=${many}`)).status, 400);
    assert.equal((await fetch(`${base}?workspaceId=ws&nodeIds=asked,,quiet`)).status, 400);
    assert.equal((await fetch(`${base}?nodeIds=asked`)).status, 400);
    assert.equal((await fetch(`${base}?workspaceId=ws&nodeIds=asked&state=done`)).status, 400);
    // The All threads list no longer takes nodeIds.
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/spaces-home/conversations?nodeIds=asked`)).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
