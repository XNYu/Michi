import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setupArtifactRoutes } from '../src/routes/artifacts';
import type { ArtifactWatchEvent } from '../src/services/artifactWatcher';

async function createFixture(t: TestContext) {
  let resolveDetached!: () => void;
  let resolveClosed!: () => void;
  const fixture = {
    base: '',
    send: undefined as ((event: ArtifactWatchEvent) => void) | undefined,
    response: undefined as express.Response | undefined,
    active: false,
    detachCount: 0,
    detached: new Promise<void>((resolve) => { resolveDetached = resolve; }),
    closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
  };
  const app = express();
  app.use((_req, res, next) => {
    fixture.response = res;
    res.once('close', resolveClosed);
    next();
  });
  app.use('/api', setupArtifactRoutes({ resolveRoot: () => '/fixture', subscribe: (_root, callback) => {
    fixture.send = callback;
    fixture.active = true;
    return () => {
      fixture.active = false;
      fixture.send = undefined;
      fixture.detachCount++;
      resolveDetached();
    };
  } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fixture.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
    // Server shutdown can finish before response close callbacks are delivered.
    if (fixture.response) await fixture.closed;
  });
  return fixture;
}

test('artifact HTTP response close detaches only its watcher', async (t) => {
  const fixture = await createFixture(t);
  const result = await fetch(`${fixture.base}/workspaces/ws/watch/stream`); assert.equal(result.status, 200);
  const reader = result.body!.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  assert.equal(fixture.active, true);
  await reader.cancel();
  await fixture.detached;
  await fixture.closed;
  assert.equal(fixture.active, false);
  assert.equal(fixture.detachCount, 1);
});

test('artifact HTTP write failure destroys response and cleans the subscription', async (t) => {
  const fixture = await createFixture(t);
  const result = await fetch(`${fixture.base}/workspaces/ws/watch/stream`); const reader = result.body!.getReader(); await reader.read();
  fixture.response!.write = () => { throw new Error('peer write failure'); };
  assert.doesNotThrow(() => fixture.send!({ filePath: 'file.md', removed: true }));
  await fixture.detached;
  await fixture.closed;
  assert.equal(fixture.response!.destroyed, true);
  assert.equal(fixture.active, false);
  assert.equal(fixture.detachCount, 1);
  await reader.cancel().catch(() => {});
});

test('direct HTTP slow consumer is disconnected at the buffer bound while the source continues', async (t) => {
  const fixture = await createFixture(t);
  const client = http.get(`${fixture.base}/workspaces/ws/watch/stream`); const [incoming] = await once(client, 'response');
  incoming.on('error', () => {}); incoming.pause();
  let sourceSteps = 0;
  const event: ArtifactWatchEvent = { filePath: 'x'.repeat(32 * 1024), removed: false, mtimeMs: 1, size: 1 };
  for (let i = 0; i < 512; i++) { sourceSteps++; fixture.send?.(event); }
  await fixture.detached;
  await fixture.closed;
  assert.equal(fixture.response!.destroyed, true);
  assert.equal(fixture.active, false);
  assert.equal(fixture.detachCount, 1);
  assert.equal(sourceSteps, 512, 'observer failure must not stop the producer'); client.destroy(); incoming.destroy();
});
