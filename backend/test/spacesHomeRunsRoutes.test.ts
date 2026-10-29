// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { closeDb, getDb, initDb } from '../src/services/db';
import { setupSpacesHomeRunRoutes } from '../src/routes/spacesHomeRuns';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobScheduler } from '../src/services/scheduledJobs/scheduler';
import { getMaintenanceConfig } from '../src/services/pages/maintenanceRepository';

let dataDir: string;
let previousDataDir: string | undefined;
let server: Server | undefined;
let baseUrl = '';
let sched: ScheduledJobScheduler;
let jobSeq = 0;

async function listen(scheduler: ScheduledJobScheduler | null): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', setupSpacesHomeRunRoutes({ scheduler, clock: () => 5_000 }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api`;
}

beforeEach(() => {
  previousDataDir = process.env.MICHI_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-spaces-home-runs-'));
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  initDb();
  getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,1,1)').run('ws-a', 'Workspace A');
  sched = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(),
    executor: { start: async () => { throw new Error('no model in route tests'); } },
    events: new ScheduledJobEventBus(() => 5_000), workspaceExists: () => true, runtimeExists: () => true,
    clock: () => 5_000, instanceId: 'routes', createId: () => `job-${++jobSeq}` });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  await sched.stop();
  closeDb();
  if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (pathname: string, body?: unknown) => fetch(`${baseUrl}${pathname}`, { method: 'POST',
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });

test('opening Spaces starts the first run once and later calls change nothing', async () => {
  await listen(sched);
  const before = await (await fetch(`${baseUrl}/spaces-home/first-run`)).json() as { requestedAt: number | null };
  assert.equal(before.requestedAt, null);
  const first = await post('/spaces-home/first-run');
  assert.equal(first.status, 200);
  const status = await first.json() as { requestedAt: number; workspaces: Array<{ workspaceId: string; firstRun: { state: string; total: number } | null }> };
  assert.equal(status.requestedAt, 5_000);
  assert.deepEqual(status.workspaces.map((home) => [home.workspaceId, home.firstRun?.state, home.firstRun?.total]), [['ws-a', 'done', 0]]);
  const jobId = getMaintenanceConfig('ws-a', 'local-user')?.jobId;
  assert.ok(jobId, 'the workspace is enrolled in managed maintenance');
  const again = await (await post('/spaces-home/first-run', {})).json() as typeof status;
  assert.deepEqual(again, status);
  assert.equal(sched.listJobs().length, 0, 'maintenance is not an ordinary scheduled job');
  assert.equal(sched.getJob(jobId).nextRunAt, null);
  assert.equal(new ScheduledJobsRepository().listMaintenanceExecutions().length, 1);
});

test('retry validates its body and the routes need the scheduler', async () => {
  await listen(sched);
  assert.equal((await post('/spaces-home/first-run/retry', { workspaceId: 7 })).status, 400);
  assert.equal((await post('/spaces-home/first-run/retry', { other: true })).status, 400);
  assert.equal((await post('/spaces-home/first-run/retry', { workspaceId: 'ws-a' })).status, 200);
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await listen(null);
  const refused = await post('/spaces-home/first-run');
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: { message: string } }).error.message, /scheduled jobs/);
});
