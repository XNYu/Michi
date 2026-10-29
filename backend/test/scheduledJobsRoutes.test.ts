import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { closeDb, getDb, initDb } from '../src/services/db';
import { PageMaintenanceConfigService } from '../src/services/pages/maintenanceConfig';
import { createLocalOriginGuard } from '../src/routes/middleware/localControl';

import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import type { ScheduledJobScheduler as Scheduler, ScheduledJobExecutor } from '../src/services/scheduledJobs/scheduler';

// Set the isolated config path before loading modules that capture it.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-job-defaults-'));
const previousConfigDir = process.env.MICHI_CONFIG_DIR;
process.env.MICHI_CONFIG_DIR = configDir;
const { setupScheduledJobRoutes } = require('../src/routes/scheduledJobs') as typeof import('../src/routes/scheduledJobs');
const { ScheduledJobScheduler } = require('../src/services/scheduledJobs/scheduler') as typeof import('../src/services/scheduledJobs/scheduler');
after(() => {
  if (previousConfigDir === undefined) delete process.env.MICHI_CONFIG_DIR;
  else process.env.MICHI_CONFIG_DIR = previousConfigDir;
  fs.rmSync(configDir, { recursive: true, force: true });
});

/** `npm run dev`'s watch build sets MICHI_DEV_RENDERER=1; only then is the Vite renderer on loopback :3001 trusted (services/localOrigins.ts). */
function withDevRenderer(t: { after: (fn: () => void) => void }): void {
  const previous = process.env.MICHI_DEV_RENDERER;
  process.env.MICHI_DEV_RENDERER = '1';
  t.after(() => { if (previous === undefined) delete process.env.MICHI_DEV_RENDERER; else process.env.MICHI_DEV_RENDERER = previous; });
}

let tmpDir: string;
let server: http.Server;
let port: number;
let scheduler: Scheduler | null;

function request(method: string, urlPath: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...options.headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const executor: ScheduledJobExecutor = {
  async start(job) {
    getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, 1, 1)')
      .run('tree-1', job.workspaceId, 'node-1');
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, status, minimized, created_at) VALUES ('node-1', ?, 'tree-1', 'chat', 'idle', 0, 1)`)
      .run(job.workspaceId);
    return {
      nodeId: 'node-1', treeId: 'tree-1', turnId: 'turn-1', cancel: () => {},
      done: Promise.resolve({ status: 'succeeded' as const, summary: 'Finished summary', error: null }),
    };
  },
};

async function startServer(withScheduler: boolean, runExecutor = executor, maxConcurrentRuns = 2): Promise<void> {
  const events = new ScheduledJobEventBus();
  scheduler = withScheduler
    ? new ScheduledJobScheduler({
        repository: new ScheduledJobsRepository(),
        executor: runExecutor,
        maxConcurrentRuns,
        events,
        workspaceExists: (id) => id === 'ws-1',
        runtimeExists: () => true,
      })
    : null;
  const app = express();
  app.use(express.json());
  app.use('/api', createLocalOriginGuard({ loopbackListener: true }));
  app.use('/api', setupScheduledJobRoutes({ scheduler, events }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
}

const body = { workspaceId: 'ws-1', name: 'Nightly', prompt: 'Check CI', schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'UTC' } };

describe('scheduled job routes', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-scheduled-routes-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    getDb().prepare(`INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-1', 'One', 1, 1)`).run();
  });

  afterEach(async () => {
    await scheduler?.stop();
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('persists defaults, applies them only to new jobs, and allows overrides', async () => {
    await startServer(true);
    const original = await request('GET', '/api/scheduled-jobs/settings');
    assert.equal(original.body.sessionMode, 'persistent');
    const first = await request('POST', '/api/scheduled-jobs', { body });
    assert.equal(first.body.sessionMode, 'persistent');
    const saved = await request('PATCH', '/api/scheduled-jobs/settings', { body: { sessionMode: 'fresh' } });
    assert.equal(saved.status, 200);
    try {
      assert.equal((await request('GET', '/api/scheduled-jobs/settings')).body.sessionMode, 'fresh');
      assert.equal((await request('POST', '/api/scheduled-jobs', { body })).body.sessionMode, 'fresh');
      assert.equal((await request('POST', '/api/scheduled-jobs', { body: { ...body, sessionMode: 'persistent' } })).body.sessionMode, 'persistent');
      assert.equal((await request('GET', `/api/scheduled-jobs/${first.body.id}`)).body.sessionMode, 'persistent');
      assert.equal((await request('PATCH', '/api/scheduled-jobs/settings', { body: { sessionMode: 'invalid' } })).status, 400);
    } finally {
      await request('PATCH', '/api/scheduled-jobs/settings', { body: original.body });
    }
  });

  test('creates, lists, updates and deletes jobs', async () => {
    await startServer(true);
    const created = await request('POST', '/api/scheduled-jobs', { body });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Nightly');
    assert.ok(created.body.nextRunAt);

    const listed = await request('GET', '/api/scheduled-jobs');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.jobs.length, 1);
    assert.equal(typeof listed.body.scheduler.timezone, 'string');

    const paused = await request('PATCH', `/api/scheduled-jobs/${created.body.id}`, { body: { enabled: false } });
    assert.equal(paused.body.enabled, false);
    assert.equal(paused.body.nextRunAt, null);

    const removed = await request('DELETE', `/api/scheduled-jobs/${created.body.id}`);
    assert.equal(removed.status, 204);
    assert.equal((await request('GET', `/api/scheduled-jobs/${created.body.id}`)).status, 404);
  });

  test('maintenance is absent from ordinary jobs and their controls cannot delete its progress', async () => {
    await startServer(true);
    const { job, config } = new PageMaintenanceConfigService(scheduler!).enable({ workspaceId: 'ws-1', ownerUserId: 'local-user' });
    const listed = await request('GET', '/api/scheduled-jobs');
    assert.deepEqual(listed.body.jobs, []);
    for (const [method, suffix] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/run'], ['POST', '/cancel']]) {
      assert.equal((await request(method, `/api/scheduled-jobs/${job.id}${suffix}`, { body: method === 'PATCH' ? { enabled: false } : undefined })).status, 404);
    }
    assert.equal(getDb().prepare('SELECT job_id FROM page_maintenance_configs WHERE workspace_id=?').get('ws-1')!.job_id, config.jobId);
    assert.equal(scheduler!.getJob(job.id).nextRunAt, null);
  });

  test('startup upgrades already-applied legacy claims so Scheduled can load', async () => {
    await startServer(true);
    const created = await request('POST', '/api/scheduled-jobs', { body });
    assert.equal(created.status, 201);
    getDb().exec(`
      DROP TABLE scheduler_execution_claims;
      CREATE TABLE scheduler_execution_claims (
        run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, holder TEXT NOT NULL,
        generation INTEGER NOT NULL, process_id INTEGER, acquired_at INTEGER NOT NULL
      );
      DELETE FROM schema_migrations WHERE version GLOB '004[34]_scheduler_claims*';
    `);
    getDb().prepare(`INSERT INTO scheduler_execution_claims VALUES ('legacy-run', ?, 'legacy-holder', 0, NULL, 100)`)
      .run(created.body.id);

    // Reproduce the installed database: 0034 is recorded, but its later
    // workspace/quarantine fields were never applied to the existing table.
    assert.ok(getDb().prepare("SELECT 1 FROM schema_migrations WHERE version = '0034_scheduler_execution_claims'").get());
    assert.equal((await request('GET', '/api/scheduled-jobs')).status, 500);
    closeDb();
    initDb();

    const listed = await request('GET', '/api/scheduled-jobs');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.jobs[0].id, created.body.id);
    assert.deepEqual(listed.body.scheduler.blockedExecutions, [{
      runId: 'legacy-run', jobId: created.body.id, workspaceId: 'ws-1',
      reason: 'An earlier Michi version did not confirm that this execution stopped', since: 100,
    }]);
    closeDb();
    initDb();
    assert.deepEqual((await request('GET', '/api/scheduled-jobs')).body, listed.body);
  });

  test('returns validation errors as 400 and conflicts as 409', async () => {
    await startServer(true);
    const invalid = await request('POST', '/api/scheduled-jobs', { body: { ...body, schedule: { kind: 'cron', expression: 'nope', timezone: null } } });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /5 fields/);
    const preview = await request('POST', '/api/scheduled-jobs/preview', { body: { schedule: body.schedule } });
    assert.equal(preview.body.valid, true);
    assert.equal(preview.body.nextRuns.length, 3);
  });

  test('runs a job now and exposes run history', async () => {
    await startServer(true);
    const created = await request('POST', '/api/scheduled-jobs', { body });
    const started = await request('POST', `/api/scheduled-jobs/${created.body.id}/run`);
    assert.equal(started.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const runs = await request('GET', `/api/scheduled-jobs/${created.body.id}/runs`);
    assert.equal(runs.body.runs[0].status, 'succeeded');
    assert.equal(runs.body.runs[0].nodeId, 'node-1');
    const single = await request('GET', `/api/scheduled-jobs/runs/${started.body.id}`);
    assert.equal(single.body.summary, 'Finished summary');
  });

  test('manual capacity conflicts are HTTP 409 and quarantine recovery requires explicit confirmation', async () => {
    // Keep start pending instead: the reservation must count before a handle exists.
    let rejectStart!: (reason: Error) => void;
    const startGate: ScheduledJobExecutor = { start: () => new Promise((_resolve, reject) => { rejectStart = reject; }) };
    await startServer(true, startGate, 1);
    const first = await request('POST', '/api/scheduled-jobs', { body });
    const second = await request('POST', '/api/scheduled-jobs', { body: { ...body, name: 'Second' } });
    assert.equal((await request('POST', `/api/scheduled-jobs/${first.body.id}/run`)).status, 202);
    const conflict = await request('POST', `/api/scheduled-jobs/${second.body.id}/run`);
    assert.equal(conflict.status, 409); assert.match(conflict.body.error, /concurrency limit/);
    await request('POST', `/api/scheduled-jobs/${first.body.id}/cancel`);
    const blocked = (await request('GET', '/api/scheduled-jobs')).body.scheduler.blockedExecutions;
    assert.equal(blocked.length, 1); assert.match(blocked[0].reason, /not confirmed it stopped/);
    const endpoint = `/api/scheduled-jobs/executions/${blocked[0].runId}/confirm-stopped`;
    assert.equal((await request('POST', endpoint, { body: {} })).status, 400);
    assert.equal((await request('POST', endpoint, { body: { executionStopped: true } })).status, 409, 'live owner cannot be bypassed');
    assert.equal((await request('DELETE', `/api/scheduled-jobs/${first.body.id}`)).status, 204);
    assert.equal((await request('GET', '/api/scheduled-jobs')).body.scheduler.blockedExecutions.length, 1, 'job deletion cannot erase unresolved occupancy');
    rejectStart(new Error('Setup cancelled before any executor was created'));
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    // Model an upgraded legacy reservation for an already deleted job. Its
    // unknown process identity requires the operator's explicit attestation.
    getDb().prepare(`INSERT INTO scheduler_execution_claims
      (run_id, job_id, holder, generation, acquired_at, workspace_id, quarantined_at, reason)
      VALUES ('legacy', ?, 'old-version', 0, 1, 'ws-1', 1, 'Unknown legacy execution')`).run(first.body.id);
    const legacyEndpoint = '/api/scheduled-jobs/executions/legacy/confirm-stopped';
    assert.equal((await request('POST', legacyEndpoint, { body: {} })).status, 400);
    const recovered = await request('POST', legacyEndpoint, { body: { executionStopped: true } });
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.body, { released: true });
    assert.equal((await request('POST', legacyEndpoint, { body: { executionStopped: true } })).status, 404);
    assert.deepEqual((await request('GET', '/api/scheduled-jobs')).body.scheduler.blockedExecutions, []);
  });

  test('replays pending notifications on the notifier stream and accepts acknowledgements', async () => {
    await startServer(true);
    const created = await request('POST', '/api/scheduled-jobs', { body });
    const started = await request('POST', `/api/scheduled-jobs/${created.body.id}/run`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frame = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/scheduled-jobs/notifications/stream' }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (chunk.includes('scheduled_job_run')) {
            resolve(chunk);
            req.destroy();
          }
        });
      });
      req.on('error', (error) => { if (!(error as NodeJS.ErrnoException).code?.includes('ECONNRESET')) reject(error); });
    });
    const event = JSON.parse(frame.split('data: ')[1]);
    assert.equal(event.runId, started.body.id);
    assert.equal(event.phase, 'finished');
    const ack = await request('POST', `/api/scheduled-jobs/runs/${started.body.id}/notified`);
    assert.equal(ack.body.acknowledged, true);
  });

  test('rejects foreign origins, cross-site requests and rebound hosts', async (t) => {
    withDevRenderer(t);
    await startServer(true);
    assert.equal((await request('GET', '/api/scheduled-jobs', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('POST', '/api/scheduled-jobs', { body, headers: { origin: 'null' } })).status, 403);
    assert.equal((await request('GET', '/api/scheduled-jobs', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request('GET', '/api/scheduled-jobs', { headers: { host: `evil.example:${port}` } })).status, 403);
    assert.equal((await request('GET', '/api/scheduled-jobs', { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
    assert.equal((await request('GET', '/api/scheduled-jobs', { headers: { origin: 'http://localhost:3001' } })).status, 200);
  });

  test('is unavailable when the scheduler is disabled', async () => {
    await startServer(false);
    assert.equal((await request('GET', '/api/scheduled-jobs')).status, 404);
  });
});
