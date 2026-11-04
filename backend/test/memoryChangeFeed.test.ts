import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { MemoryChangedEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMemory, deleteMemory, memoryEvents } from '../src/services/memory/memoryService';
import { subscribeMemoryChanges } from '../src/services/memory/memoryChangeFeed';
import { setupMemoryRoutes } from '../src/routes/memories';

let dataDir: string;

function seedWorkspace(id: string, ownerUserId: string): void {
  getDb().prepare("INSERT INTO workspaces (id, name, owner_user_id, created_at, updated_at) VALUES (?, 'Project', ?, 1, 1)")
    .run(id, ownerUserId);
}

function remember(ownerUserId: string, body: string, workspaceId?: string) {
  return createMemory({ ownerUserId }, {
    scope: workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'user' },
    kind: 'preference', body, status: 'active', origin: 'explicit',
  });
}

/** Deliveries are deferred to the next turn of the event loop. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function setupDb(): void {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-feed-'));
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  initDb();
}

function teardownDb(): void {
  closeDb();
  delete process.env.MICHI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

describe('memory change feed', () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  test('delivers each change only to subscribers of the same owner', async () => {
    seedWorkspace('ws-alice', 'alice');
    const alice: MemoryChangedEvent[] = [];
    const aliceAgain: MemoryChangedEvent[] = [];
    const bob: MemoryChangedEvent[] = [];
    const stops = [
      subscribeMemoryChanges('alice', (event) => alice.push(event)),
      subscribeMemoryChanges('alice', (event) => aliceAgain.push(event)),
      subscribeMemoryChanges('bob', (event) => bob.push(event)),
    ];
    const mine = remember('alice', 'answer in Chinese', 'ws-alice');
    const theirs = remember('bob', 'use tabs');
    remember('carol', 'nobody listens to carol');
    assert.equal(alice.length, 0, 'delivery waits for the transaction to finish');
    await settle();

    assert.deepEqual(alice.map((event) => [event.ownerUserId, event.memoryId, event.action, event.workspaceId]), [
      ['alice', mine.id, 'created', 'ws-alice'],
    ]);
    assert.deepEqual(aliceAgain.map((event) => event.memoryId), [mine.id]);
    assert.deepEqual(bob.map((event) => [event.ownerUserId, event.memoryId, event.body]), [['bob', theirs.id, 'use tabs']]);
    for (const stop of stops) stop();
  });

  test('stops delivering after unsubscribe and leaves no memoryEvents listener behind', async () => {
    const baseline = memoryEvents.listenerCount('changed');
    const seen: string[] = [];
    const stop = subscribeMemoryChanges('alice', (event) => seen.push(`${event.action}:${event.body}`));
    const other = subscribeMemoryChanges('bob', () => {});
    assert.equal(memoryEvents.listenerCount('changed'), baseline + 1);
    const first = remember('alice', 'first');
    await settle();
    stop();
    stop();
    deleteMemory({ ownerUserId: 'alice' }, first.id);
    remember('alice', 'second');
    await settle();
    assert.deepEqual(seen, ['created:first']);
    assert.equal(memoryEvents.listenerCount('changed'), baseline + 1, 'bob is still subscribed');
    other();
    assert.equal(memoryEvents.listenerCount('changed'), baseline);
  });

  test('a throwing subscriber neither fails the change nor starves the others', async () => {
    const seen: string[] = [];
    const stops = [
      subscribeMemoryChanges('alice', () => { throw new Error('renderer gone'); }),
      subscribeMemoryChanges('alice', (event) => seen.push(event.body)),
    ];
    assert.doesNotThrow(() => remember('alice', 'kept'));
    await settle();
    assert.deepEqual(seen, ['kept']);
    for (const stop of stops) stop();
  });

  test('requires an owner', () => {
    assert.throws(() => subscribeMemoryChanges('  ', () => {}), /ownerUserId/);
  });
});

describe('GET /api/memories/changes/stream (cloud)', () => {
  let server: ReturnType<typeof express.application.listen>;
  let base: string;
  const controllers: AbortController[] = [];

  beforeEach(async () => {
    setupDb();
    process.env.MICHI_CLOUD = '1';
    seedWorkspace('ws-alice', 'alice');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const owner = req.header('x-user');
      if (owner) req.user = { id: owner, email: `${owner}@example.com` };
      next();
    });
    app.use('/api', setupMemoryRoutes());
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.MICHI_CLOUD;
    teardownDb();
  });

  /** Opens the stream as `owner` and collects its memory_changed payloads. */
  async function open(owner: string) {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/memories/changes/stream`, { headers: { 'x-user': owner }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const events: MemoryChangedEvent[] = [];
    let raw = '';
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          raw += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = raw.indexOf('\n\n')) !== -1) {
            const frame = raw.slice(0, index);
            raw = raw.slice(index + 2);
            const name = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (name === 'memory_changed' && data) events.push(JSON.parse(data));
          }
        }
      } catch { /* aborted */ }
    })();
    return { events, close: () => controller.abort() };
  }

  test('answers 401 without an authenticated owner', async () => {
    const baseline = memoryEvents.listenerCount('changed');
    const response = await fetch(`${base}/memories/changes/stream`);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error?: string }).error, 'unauthorized');
    assert.equal(memoryEvents.listenerCount('changed'), baseline, 'nothing subscribed for the refused request');
  });

  test('streams the owner’s own changes, from Settings and from agents, and nobody else’s', async () => {
    const alice = await open('alice');
    const bob = await open('bob');
    // Settings adds one over REST; an agent tool writes another through the service.
    const added = await fetch(`${base}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'alice' },
      body: JSON.stringify({ scope: { kind: 'workspace', workspaceId: 'ws-alice' }, kind: 'convention', body: 'use 2 spaces' }),
    });
    assert.equal(added.status, 201);
    const fromAgent = createMemory({ ownerUserId: 'alice' }, {
      scope: { kind: 'user' }, kind: 'fact', body: 'from a web page', status: 'pending', origin: 'explicit',
      source: { nodeId: 'node-1' }, sourceRisk: 'untrusted',
    });
    remember('bob', 'bob only');
    await until(() => alice.events.length === 2 && bob.events.length === 1, 'both streams');

    assert.deepEqual(alice.events.map((event) => [event.action, event.status, event.body, event.workspaceId]), [
      ['created', 'active', 'use 2 spaces', 'ws-alice'],
      ['created', 'pending', 'from a web page', null],
    ]);
    assert.equal(alice.events[1].memoryId, fromAgent.id);
    assert.equal(alice.events[1].nodeId, 'node-1');
    assert.ok(alice.events.every((event) => event.ownerUserId === 'alice'));
    assert.deepEqual(bob.events.map((event) => [event.ownerUserId, event.body]), [['bob', 'bob only']]);

    // Closing one stream detaches only that subscriber.
    bob.close();
    const removed = await fetch(`${base}/memories/${encodeURIComponent(fromAgent.id)}`, { method: 'DELETE', headers: { 'x-user': 'alice' } });
    assert.equal(removed.status, 204);
    await until(() => alice.events.length === 3, 'the deletion');
    assert.deepEqual([alice.events[2].action, alice.events[2].memoryId], ['deleted', fromAgent.id]);
    assert.equal(bob.events.length, 1);
  });
});
