// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { updateAgentConfig } from '../src/services/agentConfig';
import { PageMaintenanceConfigService } from '../src/services/pages/maintenanceConfig';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunOutcome } from '../src/services/scheduledJobs/scheduler';
import { recordMetaAgentGuardCheck } from '../src/services/metaAgent/guardStatus';
import { resolveMetaAgentRuntime } from '../src/services/metaAgent/settings';
import { metaAgentRoundStatus, runMetaAgentRoundNow } from '../src/services/metaAgent/runNow';
import { setupMetaAgentRunNowRoutes } from '../src/routes/metaAgentRunNow';
import { setupMetaAgentRoutes } from '../src/routes/metaAgent';

const LOCAL = 'local-user';

let dir: string;
let priorDataDir: string | undefined;
let priorCloud: string | undefined;
let now: number;
let ids: number;
let started: string[];
let finish: Array<(outcome: ScheduledRunOutcome) => void>;

beforeEach(() => {
  priorDataDir = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-meta-agent-run-now-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  updateAgentConfig({ runtime: 'claude', modelByRuntime: { claude: 'claude-opus-5.5' }, reasoningByRuntime: { claude: 'high' } });
  now = 1_800_000_000_000;
  ids = 0;
  started = [];
  finish = [];
});

afterEach(async () => {
  for (const done of finish) done({ status: 'cancelled', summary: null, error: null });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  closeDb();
  if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Records which jobs started; their runs stay open until the test ends. */
function scheduler(maxConcurrentRuns = 4): ScheduledJobScheduler {
  const executor: ScheduledJobExecutor = {
    start: async (job) => {
      started.push(job.workspaceId);
      const nodeId = `run-node-${++ids}`;
      getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?,?,'chat','idle',?)").run(nodeId, job.workspaceId, now);
      const done = new Promise<ScheduledRunOutcome>((resolve) => { finish.push(resolve); });
      return { nodeId, treeId: null, turnId: null, done, cancel: () => {} };
    },
  };
  return new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: () => true,
    clock: () => now, createId: () => `job-${++ids}`, maxConcurrentRuns });
}

/** `n` conversation turns that finish in the workspace, each taking the next completion_seq. */
function complete(workspaceId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    const id = `${workspaceId}-${++ids}`;
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?,?,'chat','idle',?)").run(`node-${id}`, workspaceId, now);
    let turn = createDurableTurn({ turnId: `turn-${id}`, assistantId: `assistant-${id}`, nodeId: `node-${id}`, workspaceId, displayUserText: 'q', startedAt: now });
    beginTurn(turn);
    turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'a' } } as ChatStreamEvent);
    finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
  }
}

/** A maintained workspace whose cursor sits after `read` finished turns, with `unread` more after it. */
function maintained(jobs: ScheduledJobScheduler, id: string, read: number, unread = 0): string {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, id.toUpperCase(), LOCAL, ++ids, ids);
  complete(id, read);
  const { job } = new PageMaintenanceConfigService(jobs, () => now).enable({ workspaceId: id, ownerUserId: LOCAL });
  complete(id, unread);
  return job.id;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const outcomes = (result: ReturnType<typeof runMetaAgentRoundNow>) =>
  result.workspaces.map(({ workspaceId, outcome, skip }) => ({ workspaceId, outcome, ...(skip ? { skip } : {}) }));

describe('Meta agent run-now', () => {
  test('starts every workspace with new conversations and leaves the others alone', async () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-a', 3, 2);
    maintained(jobs, 'ws-b', 7);
    const result = runMetaAgentRoundNow({ scheduler: jobs, ownerUserId: LOCAL });
    assert.deepEqual(outcomes(result), [
      { workspaceId: 'ws-a', outcome: 'started' },
      { workspaceId: 'ws-b', outcome: 'no_new' },
    ]);
    assert.equal(result.workspaces[0].unread, 2);
    assert.equal(result.workspaces[0].cursor, 3);
    assert.match(result.workspaces[0].runId ?? '', /^run-/);
    await settle();
    assert.deepEqual(started, ['ws-a'], 'a workspace with nothing new opens no session');
    assert.deepEqual(metaAgentRoundStatus({ scheduler: jobs, ownerUserId: LOCAL, now }).workspaces.map((row) => [row.workspaceId, row.running]),
      [['ws-a', true], ['ws-b', false]]);
  });

  test('a paused workspace and a job stopped after failures are skipped with the reason', async () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-a', 1, 1);
    const stoppedJob = maintained(jobs, 'ws-b', 1, 1);
    const config = new PageMaintenanceConfigService(jobs, () => now);
    config.update({ workspaceId: 'ws-a', ownerUserId: LOCAL, expectedRevision: config.get('ws-a', LOCAL)!.revision, now, paused: true });
    getDb().prepare("UPDATE scheduled_jobs SET auto_paused=1,last_error='Claude is not signed in' WHERE id=?").run(stoppedJob);
    const result = runMetaAgentRoundNow({ scheduler: jobs, ownerUserId: LOCAL });
    assert.deepEqual(outcomes(result), [
      { workspaceId: 'ws-a', outcome: 'skipped', skip: 'paused' },
      { workspaceId: 'ws-b', outcome: 'skipped', skip: 'stopped' },
    ]);
    assert.match(result.workspaces[1].reason ?? '', /Claude is not signed in/);
    await settle();
    assert.deepEqual(started, []);
  });

  test('a failed restriction check holds every workspace, as on the schedule', async () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-a', 1, 3);
    const { followsGlobal: _f, ...profile } = resolveMetaAgentRuntime(LOCAL);
    recordMetaAgentGuardCheck({ toolset: 'maintenance', profile, ownerUserId: LOCAL, now,
      failure: { runtimeId: profile.runtimeId, unexpectedTools: ['fs_write'] } });
    const result = runMetaAgentRoundNow({ scheduler: jobs, ownerUserId: LOCAL });
    assert.deepEqual(outcomes(result), [{ workspaceId: 'ws-a', outcome: 'skipped', skip: 'guard_hold' }]);
    assert.match(result.workspaces[0].reason ?? '', /fs_write/);
    await settle();
    assert.deepEqual(started, []);
  });

  test('a runtime the Meta agent cannot run on skips every workspace', () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-a', 1, 3);
    updateAgentConfig({ runtime: 'crew' });
    const result = runMetaAgentRoundNow({ scheduler: jobs, ownerUserId: LOCAL });
    assert.deepEqual(outcomes(result), [{ workspaceId: 'ws-a', outcome: 'skipped', skip: 'unsupported_runtime' }]);
    assert.match(result.workspaces[0].reason ?? '', /Crew/);
  });

  test('a full run slot queues the workspace for the next free one; a running one says it is reading', async () => {
    const jobs = scheduler(1);
    const first = maintained(jobs, 'ws-a', 1, 1);
    const second = maintained(jobs, 'ws-b', 1, 2);
    const result = runMetaAgentRoundNow({ scheduler: jobs, ownerUserId: LOCAL });
    assert.deepEqual(outcomes(result), [
      { workspaceId: 'ws-a', outcome: 'started' },
      { workspaceId: 'ws-b', outcome: 'started' },
    ]);
    assert.equal(result.workspaces[1].runId, null);
    assert.equal(result.workspaces[1].reason, 'Starts when a run slot frees up');
    assert.ok((jobs.getJob(second).nextRunAt ?? Infinity) <= now, 'the queued workspace is due now');
    assert.deepEqual(metaAgentRoundStatus({ scheduler: jobs, ownerUserId: LOCAL, now }).workspaces.map((row) => row.running), [true, true]);

    const again = runMetaAgentRoundNow({ scheduler: jobs, ownerUserId: LOCAL });
    assert.equal(again.workspaces[0].outcome, 'started');
    assert.equal(again.workspaces[0].runId, jobs.getJob(first).activeRunId);
    assert.equal(again.workspaces[0].reason, 'Already reading');
    await settle();
    assert.deepEqual(started, ['ws-a']);
  });

  test('queued work counts as something to read', () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-a', 4);
    getDb().prepare(`INSERT INTO page_maintenance_plans(id,workspace_id,owner_user_id,job_id,run_id,config_revision,generation,after_seq,through_seq,state,created_at,updated_at)
      VALUES('plan-1','ws-a',?,?,NULL,1,1,3,4,'routing',?,?)`).run(LOCAL, jobs.listJobs()[0].id, now, now);
    assert.deepEqual(outcomes(runMetaAgentRoundNow({ scheduler: jobs, ownerUserId: LOCAL })), [{ workspaceId: 'ws-a', outcome: 'started' }]);
  });

  describe('routes', () => {
    let server: http.Server;
    let base: string;

    async function listen(withScheduler: ScheduledJobScheduler | null, remote = false): Promise<void> {
      const app = express();
      app.use(express.json());
      // What the remote-access middleware sets for a request carrying the connection's token.
      if (remote) app.use((_req, res, next) => { res.locals.remoteAccessAuthenticated = true; next(); });
      app.use('/api', setupMetaAgentRunNowRoutes({ scheduler: withScheduler, clock: () => now }));
      app.use('/api', setupMetaAgentRoutes());
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    afterEach(async () => {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    });

    function call(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: any }> {
      const url = new URL(base);
      return new Promise((resolve, reject) => {
        const req = http.request({ host: url.hostname, port: url.port, method, path: p,
          headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
    }

    test('POST runs a round and GET follows it', async () => {
      const jobs = scheduler();
      maintained(jobs, 'ws-a', 1, 1);
      await listen(jobs);
      const run = await call('POST', '/api/meta-agent/run-now', {}, '{}');
      assert.equal(run.status, 200, JSON.stringify(run.body));
      assert.equal(run.body.workspaces[0].outcome, 'started');
      const status = await call('GET', '/api/meta-agent/run-now');
      assert.deepEqual(status.body.workspaces.map((row: { running: boolean }) => row.running), [true]);
      assert.equal((await call('POST', '/api/meta-agent/run-now', {}, '{"workspaceId":"ws-a"}')).status, 400);
      assert.equal((await call('POST', '/api/meta-agent/run-now', { origin: 'https://evil.example' }, '{}')).status, 403);
    });

    test('an authenticated remote connection reaches it while the settings routes stay local-only', async () => {
      const jobs = scheduler();
      maintained(jobs, 'ws-a', 2);
      await listen(jobs, true);
      const remoteHost = { host: 'devbox.example:3000' };
      const run = await call('POST', '/api/meta-agent/run-now', remoteHost, '{}');
      assert.equal(run.status, 200, JSON.stringify(run.body));
      assert.deepEqual(run.body.workspaces.map((row: { outcome: string }) => row.outcome), ['no_new']);
      assert.equal((await call('GET', '/api/meta-agent', remoteHost)).status, 403);
    });

    test('without scheduled jobs it answers 503', async () => {
      await listen(null);
      const run = await call('POST', '/api/meta-agent/run-now', {}, '{}');
      assert.equal(run.status, 503);
      assert.equal(run.body.error.code, 'scheduler_unavailable');
      assert.equal((await call('GET', '/api/meta-agent/run-now')).status, 503);
    });
  });
});
