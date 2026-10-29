import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { MetaAgentMetricsReader } from '../src/services/metaAgentMetrics';
import { initDb, closeDb, getDbPath } from '../src/services/db';
import { metaAgentMetricsSnapshot } from '../src/services/metaAgent/todayUsage';

// The fixture deliberately blocks its own event loop. HTTP on the main thread
// must keep responding while this work runs, and duplicate reads share one RPC.
function slowWorker(blocker: SharedArrayBuffer): Worker {
  return new Worker(`
    const { parentPort, workerData } = require('node:worker_threads'); let count = 0;
    parentPort.on('message', ({ id, ownerUserId, now }) => {
      Atomics.wait(new Int32Array(workerData.blocker), 0, 0);
      const day = new Date(now); day.setHours(0,0,0,0);
      parentPort.postMessage({ id, durationMs: 200, result: {
        dayStart: day.getTime(), today: { checks: ++count, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
        usage: { checks: count, modelCalls: 0, tokens: ownerUserId === 'owner-a' ? 42 : 9 }
      } });
    });`, { eval: true, workerData: { blocker } });
}

test('heavy statistics are isolated from HTTP, coalesced, cached, and scoped by owner/day', async () => {
  let clock = new Date(2026, 0, 15, 12).getTime();
  const blocker = new SharedArrayBuffer(4);
  const release = () => { Atomics.store(new Int32Array(blocker), 0, 1); Atomics.notify(new Int32Array(blocker), 0); };
  const reader = new MetaAgentMetricsReader('fixture', { workerFactory: () => slowWorker(blocker), clock: () => clock });
  const server = http.createServer((_, res) => res.end('saved local page'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    let completed = false;
    const first = reader.read('owner-a', clock);
    assert.equal(reader.read('owner-a', clock), first);
    void first.then(() => { completed = true; }, () => {});
    assert.equal(await (await fetch(url)).text(), 'saved local page');
    assert.equal(completed, false, 'local reading does not queue behind background CPU');
    release();
    const initial = await first;
    assert.equal(initial.usage.tokens, 42);
    assert.equal(await reader.read('owner-a', clock), initial);
    assert.equal((await reader.read('owner-b', clock)).usage.tokens, 9);
    assert.notEqual((await reader.read('owner-a', clock + 86_400_000)).dayStart, initial.dayStart);
    clock += 31_000;
    assert.equal(await reader.read('owner-a', clock), initial, 'stale snapshot is returned while refreshing');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok((await reader.read('owner-a', clock)).today.checks > initial.today.checks);
  } finally {
    release();
    await reader.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

test('a hung worker has a deadline and never falls back to synchronous work', async () => {
  const reader = new MetaAgentMetricsReader('fixture', { deadlineMs: 60, workerFactory: () => new Worker(
    `require('node:worker_threads').parentPort.on('message', () => {});`, { eval: true },
  ) });
  try {
    await assert.rejects(reader.read('owner'), /timed out/);
    await assert.rejects(reader.read('owner'), /recovering/);
  } finally { await reader.close(); }
  await assert.rejects(reader.read('owner'), /closed/);
});

test('real read-only worker computes the same owner-scoped statistics as the repository', async () => {
  const original = process.env.MICHI_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-metrics-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb(); const database = initDb();
  const now = Date.now();
  for (const owner of ['owner-a', 'owner-b']) {
    database.prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(owner, owner, owner, now, now);
    database.prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,created_at,updated_at)
      VALUES (?,?,?,'maintenance','read','{"kind":"every","minutes":60}',?,?)`).run(`job-${owner}`, owner, owner, now, now);
    database.prepare(`INSERT INTO page_maintenance_configs(workspace_id,owner_user_id,job_id,enabled,completion_cursor,updated_at)
      VALUES (?,?,?,1,0,?)`).run(owner, owner, `job-${owner}`, now);
    database.prepare(`INSERT INTO nodes(id,workspace_id,kind,status,minimized,spawned_by_agent,created_at,maintenance_job_id)
      VALUES (?,?,'chat','idle',0,0,?,?)`).run(`node-${owner}`, owner, now, `job-${owner}`);
    database.prepare(`INSERT INTO messages(id,node_id,role,content,seq,created_at,metadata)
      VALUES (?,?,'assistant','content',0,?,?)`).run(`message-${owner}`, `node-${owner}`, now, JSON.stringify({ usageSummary: { totalTokens: owner === 'owner-a' ? 42 : 9 } }));
  }
  const reader = new MetaAgentMetricsReader(getDbPath());
  try {
    for (const owner of ['owner-a', 'owner-b']) {
      const result = await reader.read(owner, now);
      assert.deepEqual(result, metaAgentMetricsSnapshot(owner, now, database));
      assert.equal(result.usage.tokens, owner === 'owner-a' ? 42 : 9);
    }
  } finally {
    await reader.close(); closeDb();
    if (original === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deadline does not start a replacement while a native worker is still terminating', async () => {
  let clock = Date.now();
  let starts = 0;
  let finishTermination!: () => void;
  const termination = new Promise<number>(resolve => { finishTermination = () => resolve(1); });
  const reader = new MetaAgentMetricsReader('fixture', {
    deadlineMs: 20, clock: () => clock,
    workerFactory: () => {
      starts++;
      return Object.assign(new EventEmitter(), {
        postMessage() {}, ref() {}, unref() {}, terminate: () => termination,
      }) as unknown as Worker;
    },
  });
  try {
    await assert.rejects(reader.read('owner', clock), /timed out/);
    clock += 10_000;
    await assert.rejects(reader.read('owner', clock), /recovering/);
    assert.equal(starts, 1, 'cooldown alone must not allow overlapping native queries');
  } finally { finishTermination(); await reader.close(); }
});
