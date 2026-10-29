import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { updateAgentConfig } from '../src/services/agentConfig';
import { PageMaintenanceConfigService } from '../src/services/pages/maintenanceConfig';
import { getMaintenanceConfig } from '../src/services/pages/maintenanceRepository';
import { maintenanceCoordinatorState } from '../src/services/metaAgent/maintenanceCoordinator';
import { metaAgentOverview, setMetaAgentPaused } from '../src/services/metaAgent/overview';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobScheduler, type ScheduledRunOutcome } from '../src/services/scheduledJobs/scheduler';

const owner = 'local-user';
let dir: string, previous: string | undefined, now: number, seq: number;
let scheduler: ScheduledJobScheduler;
let calls: string[];
let finish: ((outcome: ScheduledRunOutcome) => void) | null;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  previous = process.env.MICHI_DATA_DIR;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-coordinator-'));
  process.env.MICHI_DATA_DIR = dir;
  closeDb(); initDb();
  now = Date.parse('2026-10-28T09:00:00Z'); seq = 0; calls = []; finish = null;
  updateAgentConfig({ runtime: 'pi' });
  scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), events: new ScheduledJobEventBus(() => now),
    workspaceExists: () => true, runtimeExists: () => true, clock: () => now, createId: () => `job-${++seq}`,
    pollIntervalMs: 600_000, maxConcurrentRuns: 4,
    executor: { start: async job => {
      calls.push(job.workspaceId);
      const nodeId = `exec-${++seq}`;
      getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?,?,'chat','idle',?)").run(nodeId, job.workspaceId, now);
      const done = new Promise<ScheduledRunOutcome>(resolve => { finish = resolve; });
      return { nodeId, treeId: null, turnId: null, done, cancel: () => finish?.({ status: 'cancelled', summary: null, error: null }) };
    } },
  });
});

afterEach(async () => {
  finish?.({ status: 'cancelled', summary: null, error: null });
  await flush(); await scheduler.stop(); await flush();
  closeDb();
  if (previous === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

function enroll(id: string, paused = false): string {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, id, owner, ++seq, now);
  return new PageMaintenanceConfigService(scheduler, () => now).enable({ workspaceId: id, ownerUserId: owner, paused }).job.id;
}

function complete(workspaceId: string): void {
  const nodeId = `node-${++seq}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?,?,'chat','idle',?)").run(nodeId, workspaceId, now);
  const turn = createDurableTurn({ turnId: `turn-${seq}`, assistantId: `answer-${seq}`, nodeId, workspaceId, displayUserText: 'Ship the change', startedAt: now });
  beginTurn(turn);
  const chunk = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'The change is ready.' } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(chunk, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
}

async function tick(): Promise<void> { await scheduler.tick(); await flush(); }

test('idle checks create no runs or AI calls, and maintenance never consumes the prompt-job list or quota', async () => {
  const a = enroll('a'); const b = enroll('b');
  scheduler.start(); await tick();
  for (let i = 0; i < 3; i++) { now += 61_000; await tick(); }
  assert.deepEqual(calls, []);
  assert.equal(scheduler.listRuns(a).length + scheduler.listRuns(b).length, 0);
  assert.deepEqual(scheduler.listJobs(), []);
  assert.deepEqual(new ScheduledJobsRepository().listScheduledJobs(), []);
  assert.equal(new ScheduledJobsRepository().countJobs(), 0);
  assert.equal(scheduler.getJob(a).nextRunAt, null);
  assert.equal(maintenanceCoordinatorState(owner).lastCheckedAt, now);
  assert.equal(metaAgentOverview({ ownerUserId: owner, now }).today.checks, 4);
  assert.throws(() => scheduler.requirePromptJob(a), /Scheduled job not found/);

  const plain = scheduler.createJob({ workspaceId: 'a', name: 'Daily', prompt: 'Read the news', schedule: { kind: 'every', everySeconds: 60 } });
  now += 61_000; await tick();
  assert.deepEqual(calls, ['a'], 'ordinary prompts execute with no new conversation');
  assert.equal(scheduler.listRuns(plain.id).length, 1);
});

test('global pause persists and preserves local pauses, cursors and newly enrolled workspaces', async () => {
  const a = enroll('a'); enroll('b', true); complete('a'); complete('b');
  const before = getMaintenanceConfig('a', owner)!;
  setMetaAgentPaused({ scheduler, ownerUserId: owner, paused: true, clock: () => now });
  enroll('c'); complete('c');
  closeDb(); initDb();
  scheduler.start(); await tick();
  assert.deepEqual(calls, []);
  assert.equal(maintenanceCoordinatorState(owner).paused, true);
  assert.deepEqual(getMaintenanceConfig('a', owner), before);
  assert.equal(getMaintenanceConfig('b', owner)!.paused, true);
  setMetaAgentPaused({ scheduler, ownerUserId: owner, paused: false, clock: () => now });
  await tick();
  assert.deepEqual(calls, ['a']);
  assert.equal(scheduler.getJob(a).nextRunAt, null);
  assert.equal(getMaintenanceConfig('b', owner)!.paused, true);
});

test('only one maintenance execution is admitted and failures yield to another workspace', async () => {
  const a = enroll('a'); const b = enroll('b'); complete('a'); complete('b');
  scheduler.start(); await tick();
  assert.deepEqual(calls, ['a']);
  const second = scheduler.startNow(b);
  assert.ok('refused' in second && second.refused === 'capacity');
  finish!({ status: 'failed', summary: null, error: 'Temporary error' });
  await flush(); await tick();
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(getMaintenanceConfig('a', owner)!.completionCursor, 0);
  assert.equal(scheduler.getJob(a).nextRunAt, null);
});

test('retry backoff starts when a long execution fails, not when it started', async () => {
  enroll('a'); complete('a'); scheduler.start(); await tick();
  // Keep the lease alive while the model takes five minutes.
  for (let i = 0; i < 10; i++) { now += 30_000; await tick(); }
  finish!({ status: 'failed', summary: null, error: 'Temporary error' });
  await flush(); await tick();
  assert.deepEqual(calls, ['a']);
  now += 61_000; await tick();
  assert.deepEqual(calls, ['a', 'a']);
});

test('pausing globally lets an active execution settle and holds the next workspace', async () => {
  const a = enroll('a'); enroll('b'); complete('a'); complete('b');
  scheduler.start(); await tick();
  const active = scheduler.getJob(a).activeRunId;
  const revision = getMaintenanceConfig('a', owner)!.revision;
  setMetaAgentPaused({ scheduler, ownerUserId: owner, paused: true, clock: () => now });
  assert.equal(scheduler.getJob(a).activeRunId, active);
  assert.equal(getMaintenanceConfig('a', owner)!.revision, revision);
  finish!({ status: 'failed', summary: null, error: 'Temporary error' });
  await flush(); now += 120_000; await tick();
  assert.deepEqual(calls, ['a']);
  setMetaAgentPaused({ scheduler, ownerUserId: owner, paused: false, clock: () => now });
  await tick();
  assert.deepEqual(calls, ['a', 'b']);
});

test('migration retains execution IDs, local pauses, cursors, plans, receipts and ordinary schedules', () => {
  const a = enroll('a', true);
  const plain = scheduler.createJob({ workspaceId: 'a', name: 'Space maintenance', prompt: 'User prompt with same name', schedule: { kind: 'every', everySeconds: 120 } });
  getDb().prepare(`INSERT INTO page_maintenance_plans(id,workspace_id,owner_user_id,job_id,config_revision,generation,after_seq,through_seq,state,created_at,updated_at)
    VALUES('plan','a',?,?,1,1,0,0,'terminal',?,?)`).run(owner, a, now, now);
  getDb().prepare(`INSERT INTO page_maintenance_receipts(receipt_key,plan_id,job_id,source_turn_id,resource_kind,resource_id,generation,
    payload_hash,payload_json,assigned_ids_json,result_json,outcome,execution_json,evidence_json,committed_at)
    VALUES('receipt','plan',?,'source','page','page',1,?,'{}','{}','{}','written','{}','{}',?)`).run(a, 'a'.repeat(64), now);
  const receipt = getDb().prepare("SELECT * FROM page_maintenance_receipts WHERE receipt_key='receipt'").get();
  const before = getMaintenanceConfig('a', owner);
  getDb().prepare('UPDATE scheduled_jobs SET next_run_at=42,owner_user_id=NULL WHERE id=?').run(a);
  getDb().exec("ALTER TABLE scheduled_jobs DROP COLUMN execution_kind; DROP TABLE meta_agent_maintenance_state; DELETE FROM schema_migrations WHERE version='0054_meta_agent_coordinator'");
  closeDb(); initDb();
  assert.deepEqual(getMaintenanceConfig('a', owner), before);
  assert.equal(scheduler.getJob(a).nextRunAt, null);
  assert.equal(new ScheduledJobsRepository().getJob(a)!.record.executionKind, 'maintenance');
  assert.equal(new ScheduledJobsRepository().getJob(a)!.record.ownerUserId, owner);
  assert.deepEqual(scheduler.listJobs().map(job => job.id), [plain.id]);
  assert.equal(scheduler.getJob(plain.id).nextRunAt, plain.nextRunAt);
  assert.equal(getDb().prepare("SELECT job_id FROM page_maintenance_plans WHERE id='plan'").get()!.job_id, a);
  assert.deepEqual(getDb().prepare("SELECT * FROM page_maintenance_receipts WHERE receipt_key='receipt'").get(), receipt);
  assert.deepEqual(getDb().prepare('PRAGMA foreign_key_check').all(), []);
});
