import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbWorker, initDbWorker, isDbWorkerReady, shutdownDbWorker } from '../src/services/dbWorkerClient';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-db-worker-lifecycle-')); });
afterEach(async () => { await shutdownDbWorker(); fs.rmSync(directory, { recursive: true, force: true }); });

test('a synchronous worker construction failure rejects initialization and permits retry', async () => {
  let startup: Promise<void> | undefined;
  assert.doesNotThrow(() => {
    // Worker rejects noncloneable workerData before its event handlers exist.
    startup = initDbWorker(Symbol('invalid-db-path') as unknown as string);
  });
  await assert.rejects(startup!, { name: 'DataCloneError' });
  assert.equal(isDbWorkerReady(), false);
  await initDbWorker(path.join(directory, 'data.db'));
  assert.equal(await dbWorker.ping(), 'pong');
});

test('startup failure rejects readiness and a subsequent initialized worker is usable', async () => {
  const startup = initDbWorker(path.join(directory, 'missing-parent', 'data.db'));
  assert.equal(isDbWorkerReady(), false, 'constructed is not ready');
  await assert.rejects(dbWorker.ping(), /not ready/);
  await assert.rejects(startup, /unable to open database file/);
  assert.equal(isDbWorkerReady(), false);
  await initDbWorker(path.join(directory, 'data.db'));
  assert.equal(isDbWorkerReady(), true);
  assert.equal(await dbWorker.ping(), 'pong');
});

test('shutdown during startup rejects readiness without clearing a replacement generation', async () => {
  const startup = initDbWorker(path.join(directory, 'data.db'));
  const stopped = assert.rejects(startup, /dbWorker stopped/);
  assert.equal(isDbWorkerReady(), false);
  const shutdown = shutdownDbWorker();
  assert.equal(isDbWorkerReady(), false);
  // Start the replacement before the old worker has delivered its exit event.
  const replacement = initDbWorker(path.join(directory, 'data.db'));
  await shutdown;
  await stopped;
  await replacement;
  assert.equal(isDbWorkerReady(), true);
  assert.equal(await dbWorker.ping(), 'pong');
});

test('shutdown rejects an outstanding RPC and does not replay it on restart', async () => {
  await initDbWorker(path.join(directory, 'data.db'));
  const pending = assert.rejects(dbWorker.ping(), /dbWorker stopped/);
  await shutdownDbWorker();
  await pending;
  await assert.rejects(dbWorker.ping(), /not ready/);
  await initDbWorker(path.join(directory, 'data.db'));
  assert.equal(await dbWorker.ping(), 'pong');
});
