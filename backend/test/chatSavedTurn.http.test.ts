import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { closeDb, getDb, initDb } from '../src/services/db';
import { listMessages, saveMessage, saveNode, saveWorkspace } from '../src/services/dbRepository';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';

let dataDir: string;
let server: Server;
let base: string;

function seedChat(owner: string, opts: { runtimeChatId?: string } = {}): void {
  saveWorkspace({ id: `ws-${owner}`, name: owner, owner_user_id: owner, created_at: 1, updated_at: 1 });
  saveNode({
    id: `node-${owner}`, workspace_id: `ws-${owner}`, kind: 'chat', status: 'idle', minimized: 0,
    spawned_by_agent: 0, external_session_id: opts.runtimeChatId ?? null, created_at: 1,
  });
  saveMessage({ id: `ask-${owner}`, node_id: `node-${owner}`, role: 'user', content: 'Question', seq: 0, created_at: 2 });
  saveMessage({
    id: `answer-${owner}`, node_id: `node-${owner}`, role: 'assistant', content: `Saved answer of ${owner}`, seq: 1, created_at: 3,
    blocks: JSON.stringify([{ kind: 'text', text: `Saved answer of ${owner}` }]),
    tool_calls: JSON.stringify([{ id: 'read', title: 'Read', status: 'completed', output: 'ok' }]),
    metadata: JSON.stringify({ usageSummary: { totalCredits: 1 } }),
  });
  getDb().prepare(`INSERT INTO turns
    (turn_id, node_id, user_message_id, assistant_message_id, status, last_seq, stop_reason, started_at, completed_at, updated_at)
    VALUES (?, ?, ?, ?, 'completed', 4, 'end_turn', 10, 20, 20)`)
    .run(`turn-${owner}`, `node-${owner}`, `ask-${owner}`, `answer-${owner}`);
}

async function read(chatId: string, turnId: string, user?: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/api/chats/${chatId}/turns/${turnId}`, { headers: user ? { 'x-user': user } : {} });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-saved-turn-'));
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb(); initDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.headers['x-user'];
    if (typeof user === 'string') (req as any).user = { id: user };
    next();
  });
  app.use('/api', setupMichiRoutes({} as ChatManager));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  delete process.env.MICHI_CLOUD;
  delete process.env.MICHI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /chats/:chatId/turns/:turnId', () => {
  test('returns the turn receipt and the stored assistant row hydration reads', async () => {
    seedChat('alice');
    const { status, body } = await read('node-alice', 'turn-alice');
    assert.equal(status, 200);
    assert.deepEqual({ ...body, message: undefined }, {
      turnId: 'turn-alice', assistantId: 'answer-alice', status: 'completed', stopReason: 'end_turn',
      completedAt: 20, lastSeq: 4, message: undefined,
    });
    const stored = listMessages('node-alice').find((message) => message.id === 'answer-alice');
    assert.deepEqual(body.message, JSON.parse(JSON.stringify(stored)));
  });

  test('a missing turn, or one belonging to another chat, is not found', async () => {
    seedChat('alice');
    seedChat('bob');
    assert.equal((await read('node-alice', 'turn-missing')).status, 404);
    assert.equal((await read('node-alice', 'turn-bob')).status, 404);
  });

  test('cloud mode serves only the owner, by node id or runtime chat id', async () => {
    process.env.MICHI_CLOUD = '1';
    seedChat('alice', { runtimeChatId: 'runtime-alice' });
    seedChat('bob');
    assert.equal((await read('node-alice', 'turn-alice', 'alice')).status, 200);
    const byRuntimeId = await read('runtime-alice', 'turn-alice', 'alice');
    assert.equal(byRuntimeId.status, 200);
    assert.equal(byRuntimeId.body.message.content, 'Saved answer of alice');
    for (const [chatId, turnId, user, expected] of [
      ['node-alice', 'turn-alice', 'bob', 404],
      ['runtime-alice', 'turn-alice', 'bob', 404],
      ['node-bob', 'turn-bob', 'alice', 404],
      ['node-alice', 'turn-bob', 'alice', 404],
      ['node-alice', 'turn-alice', undefined, 401],
    ] as const) {
      const denied = await read(chatId, turnId, user);
      assert.equal(denied.status, expected, `${user} reading ${chatId}/${turnId}`);
      assert.equal(JSON.stringify(denied.body).includes('Saved answer'), false);
    }
  });
});
