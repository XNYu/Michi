import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScheduledJobRunEvent } from 'michi-shared';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { closeDb, getDb, initDb } from '../src/services/db';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import {
  JobValidationError,
  ScheduledJobConflictError,
  ScheduledJobScheduler,
  type ScheduledJobExecutor,
  type ScheduledRunHandle,
  type ScheduledRunHooks,
  type ScheduledRunOutcome,
} from '../src/services/scheduledJobs/scheduler';

let tmpDir: string;
let now: number;
let nextId: number;

function seedWorkspace(id: string, deletedAt: number | null = null): void {
  getDb().prepare('INSERT INTO workspaces (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, 1, 1, ?)')
    .run(id, id, deletedAt);
}

interface StartedRun {
  job: ScheduledJobRecord;
  run: ScheduledJobRunRecord;
  hooks: ScheduledRunHooks;
  resolve(outcome: ScheduledRunOutcome): void;
  cancelled: boolean;
}

class FakeExecutor implements ScheduledJobExecutor {
  readonly started: StartedRun[] = [];
  failStart: Error | null = null;
  autoResolve: ScheduledRunOutcome | null = null;

  async start(job: ScheduledJobRecord, run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    if (this.failStart) throw this.failStart;
    let resolve!: (outcome: ScheduledRunOutcome) => void;
    const done = new Promise<ScheduledRunOutcome>((settle) => { resolve = settle; });
    const entry: StartedRun = { job, run, hooks, resolve, cancelled: false };
    this.started.push(entry);
    const index = this.started.length;
    // Real graph rows, so run/job foreign keys hold as in production.
    getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, 1, 1)')
      .run(`tree-${index}`, job.workspaceId, `node-${index}`);
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, status, minimized, created_at) VALUES (?, ?, ?, 'chat', 'idle', 0, 1)`)
      .run(`node-${index}`, job.workspaceId, `tree-${index}`);
    if (this.autoResolve) resolve(this.autoResolve);
    return {
      nodeId: `node-${index}`,
      treeId: `tree-${index}`,
      turnId: `turn-${index}`,
      done,
      cancel: () => {
        entry.cancelled = true;
        resolve({ status: 'cancelled', summary: null, error: null });
      },
    };
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await flush();
}

describe('ScheduledJobScheduler', () => {
  let executor: FakeExecutor;
  let events: ScheduledJobEventBus;
  let published: ScheduledJobRunEvent[];
  let wakes: number;
  let schedulers: ScheduledJobScheduler[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-scheduled-jobs-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    now = Date.parse('2026-10-16T12:00:00Z');
    nextId = 0;
    seedWorkspace('ws-a');
    seedWorkspace('ws-trashed', 5);
    executor = new FakeExecutor();
    events = new ScheduledJobEventBus(() => now);
    published = [];
    events.subscribe({ send: (event) => published.push(event) });
    wakes = 0;
    schedulers = [];
  });

  afterEach(async () => {
    for (const scheduler of schedulers) await scheduler.stop();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeScheduler(overrides: Partial<ConstructorParameters<typeof ScheduledJobScheduler>[0]> = {}): ScheduledJobScheduler {
    const scheduler = new ScheduledJobScheduler({
      repository: new ScheduledJobsRepository(),
      executor,
      events,
      workspaceExists: (id) => id === 'ws-a',
      runtimeExists: (id) => id === 'kiro' || id === 'pi',
      launcher: { wake: () => { wakes += 1; return true; } },
      clock: () => now,
      instanceId: 'instance-a',
      createId: () => `job-${++nextId}`,
      pollIntervalMs: 60_000,
      notifierGraceMs: 0,
      cancelGraceMs: 10,
      ...overrides,
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  const baseJob = {
    workspaceId: 'ws-a',
    name: 'Morning digest',
    prompt: 'Summarize what changed overnight.',
    schedule: { kind: 'every', everySeconds: 3600 },
  };

  function completeInput(id: string, workspaceId = 'ws-a'): void {
    getDb().prepare("INSERT OR IGNORE INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('source', ?, 'chat', 'idle', 1)").run(workspaceId);
    let turn = createDurableTurn({ turnId: id, assistantId: `a-${id}`, nodeId: 'source', workspaceId,
      displayUserText: id, startedAt: now });
    beginTurn(turn);
    turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'conclusion' } } as ChatStreamEvent);
    finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
  }

  test('opt-in starts from now and an empty tick never starts an executor or sends a notification', async () => {
    completeInput('historical');
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, conversationUpdates: true });
    assert.equal(job.conversationCursor, 1);
    const run = await scheduler.runNow(job.id);
    await settle();
    assert.equal(executor.started.length, 0);
    assert.equal(scheduler.getRun(run.id).status, 'succeeded');
    assert.equal(scheduler.getJob(job.id).conversationCursor, 1);
    assert.equal(scheduler.pendingNotifications().length, 0);
    assert.equal(wakes, 0);
    assert.equal(published.find(e => e.phase === 'finished')?.notify, false);
    assert.deepEqual(scheduler.validateUpdate(job.id, { conversationUpdates: true }), {});
  });

  test('passes bounded full inputs and requires explicit confirmation of every turn', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, conversationUpdates: true });
    completeInput('a'); completeInput('b');
    await scheduler.runNow(job.id);
    await settle();
    assert.deepEqual(executor.started[0].hooks.conversationBatch?.turns.map(t => t.turnId), ['a', 'b']);
    assert.deepEqual(executor.started[0].hooks.conversationBatch?.turns[0].messages?.map(m => m.content), ['a', 'conclusion']);
    executor.started[0].resolve({ status: 'succeeded', summary: 'done', error: null });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
    assert.equal(scheduler.getJob(job.id).lastStatus, 'failed');
    await scheduler.runNow(job.id);
    executor.started[1].resolve({ status: 'succeeded', summary: 'no change', error: null, conversationHandledTurnIds: ['a'] });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
    await scheduler.runNow(job.id);
    executor.started[2].resolve({ status: 'succeeded', summary: 'no change', error: null, conversationHandledTurnIds: ['a', 'b'] });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 2);
    assert.equal(scheduler.getJob(job.id).lastStatus, 'succeeded');
  });

  test('failure, cancellation, attention and stale lease retain progress', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, conversationUpdates: true });
    completeInput('source-turn');
    await scheduler.runNow(job.id);
    executor.started[0].resolve({ status: 'failed', summary: null, error: 'failed', conversationHandledTurnIds: ['source-turn'] });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
    await scheduler.runNow(job.id);
    executor.started[1].hooks.onAttention('input');
    executor.started[1].resolve({ status: 'succeeded', summary: null, error: null, conversationHandledTurnIds: ['source-turn'] });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
    await scheduler.runNow(job.id);
    scheduler.cancelActiveRun(job.id);
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
    const stale = await scheduler.runNow(job.id);
    getDb().prepare("UPDATE scheduler_lease SET holder = 'another-instance' WHERE id = 1").run();
    executor.started[3].resolve({ status: 'succeeded', summary: null, error: null, conversationHandledTurnIds: ['source-turn'] });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
    assert.equal(scheduler.getRun(stale.id).status, 'interrupted');
    assert.equal(scheduler.getJob(job.id).lastStatus, 'cancelled', 'lost owner cannot overwrite the previous result');
  });

  test('cursor compare-and-set rejects late advancement and page size caps a single run', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, conversationUpdates: true });
    for (let i = 0; i < 23; i++) completeInput(`input-${i}`);
    await scheduler.runNow(job.id);
    const page = executor.started[0].hooks.conversationBatch!;
    assert.equal(page.turns.length, 20);
    assert.equal(page.hasMore, true);
    assert.throws(() => scheduler.updateJob(job.id, { conversationUpdates: false }), ScheduledJobConflictError);
    new ScheduledJobsRepository().updateJob(job.id, { conversationCursor: 1 });
    executor.started[0].resolve({ status: 'succeeded', summary: null, error: null, conversationHandledTurnIds: page.turns.map(t => t.turnId) });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 1);
    assert.equal(scheduler.getJob(job.id).lastStatus, 'failed');
    await scheduler.runNow(job.id);
    const retry = executor.started[1].hooks.conversationBatch!;
    executor.started[1].resolve({ status: 'succeeded', summary: null, error: null, conversationHandledTurnIds: retry.turns.map(t => t.turnId) });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 21);
  });

  test('timeout followed by a late acknowledgment cannot advance the cursor', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, conversationUpdates: true });
    new ScheduledJobsRepository().updateJob(job.id, { timeoutSeconds: 0.01 });
    completeInput('late');
    await scheduler.runNow(job.id);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(scheduler.getJob(job.id).lastStatus, 'timed_out');
    executor.started[0].resolve({ status: 'succeeded', summary: null, error: null, conversationHandledTurnIds: ['late'] });
    await settle();
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
  });

  test('oversized input and disabled navigation fail before runtime creation; disable/re-enable resets to now', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, conversationUpdates: true });
    completeInput('large');
    getDb().prepare("UPDATE messages SET content = ? WHERE role = 'user'").run('x'.repeat(70000));
    await scheduler.runNow(job.id);
    await settle();
    assert.equal(executor.started.length, 0);
    assert.equal(scheduler.getJob(job.id).conversationCursor, 0);
    scheduler.updateJob(job.id, { conversationUpdates: false });
    assert.equal(scheduler.getJob(job.id).conversationCursor, null);
    scheduler.updateJob(job.id, { conversationUpdates: true });
    assert.equal(scheduler.getJob(job.id).conversationCursor, 1);
    getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run('{"aiGlobalContext":false}', 'ws-a');
    await scheduler.runNow(job.id);
    await settle();
    assert.equal(executor.started.length, 0);
    assert.equal(scheduler.getJob(job.id).lastStatus, 'failed');
  });

  test('creates a job with defaults and the first due time', () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob(baseJob);
    assert.equal(job.id, 'job-1');
    assert.equal(job.permissionMode, 'trust');
    assert.equal(job.sessionMode, 'persistent');
    assert.equal(job.notify, true);
    assert.equal(job.timeoutSeconds, 1800);
    assert.equal(job.nextRunAt, now + 3_600_000);
  });

  test('announces created, edited and deleted jobs as change events, not run events', () => {
    const changes: Array<{ change: string; jobId: string; workspaceId: string }> = [];
    events.subscribe({ send: () => {}, sendChange: (event) => changes.push(event) });
    const scheduler = makeScheduler();
    const job = scheduler.createJob(baseJob);
    scheduler.updateJob(job.id, { name: 'Renamed' });
    scheduler.deleteJob(job.id);
    assert.deepEqual(changes.map(({ change, jobId, workspaceId }) => ({ change, jobId, workspaceId })), [
      { change: 'created', jobId: job.id, workspaceId: 'ws-a' },
      { change: 'updated', jobId: job.id, workspaceId: 'ws-a' },
      { change: 'deleted', jobId: job.id, workspaceId: 'ws-a' },
    ]);
    assert.equal(published.length, 0);
  });

  test('validates without saving and reports only fields that change', () => {
    const scheduler = makeScheduler();
    const fields = scheduler.validateCreate(baseJob);
    assert.equal(fields.permissionMode, 'trust');
    assert.equal(scheduler.listJobs().length, 0);
    const job = scheduler.createJob(baseJob);
    assert.deepEqual(scheduler.validateUpdate(job.id, { name: 'Morning digest', notify: false }), { notify: false });
    assert.equal(scheduler.getJob(job.id).notify, true);
    assert.throws(() => scheduler.validateUpdate(job.id, { schedule: { kind: 'every', everySeconds: 5 } }), JobValidationError);
  });

  test('rejects invalid input with readable messages', () => {
    const scheduler = makeScheduler();
    assert.throws(() => scheduler.createJob({ ...baseJob, workspaceId: 'ws-trashed' }), /Workspace not found/);
    assert.throws(() => scheduler.createJob({ ...baseJob, name: '  ' }), /Name is required/);
    assert.throws(() => scheduler.createJob({ ...baseJob, schedule: undefined }), /Schedule is required/);
    assert.throws(() => scheduler.createJob({ ...baseJob, runtimeId: 'missing' }), /not available/);
    assert.throws(() => scheduler.createJob({ ...baseJob, permissionMode: 'root' }), JobValidationError);
    assert.throws(() => scheduler.createJob({ ...baseJob, timeoutSeconds: 5 }), /Timeout/);
    assert.throws(() => scheduler.createJob({ ...baseJob, schedule: { kind: 'at', at: now - 1000 } }), /future/);
  });

  test('runs a due job, records the result and advances the schedule', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob(baseJob);
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(executor.started.length, 0, 'not due yet');

    now += 3_600_000;
    await scheduler.tick();
    await settle();
    assert.equal(executor.started.length, 1);
    const running = scheduler.getJob(job.id);
    assert.ok(running.activeRunId);
    assert.equal(running.nextRunAt, now + 3_600_000);
    assert.deepEqual(published.map((event) => event.phase), ['started']);
    assert.equal(published[0].nodeId, 'node-1');

    executor.started[0].resolve({ status: 'succeeded', summary: 'All quiet.', error: null });
    await settle();
    const finished = scheduler.getJob(job.id);
    assert.equal(finished.activeRunId, null);
    assert.equal(finished.lastStatus, 'succeeded');
    const [run] = scheduler.listRuns(job.id);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.summary, 'All quiet.');
    assert.equal(run.nodeId, 'node-1');
    assert.equal(published.at(-1)?.phase, 'finished');
    assert.equal(wakes, 1, 'no notifier connected, so the app is woken');
  });

  test('skips an occurrence that would overlap a running run', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, schedule: { kind: 'every', everySeconds: 60 } });
    scheduler.start();
    await scheduler.tick();
    now += 60_000;
    await scheduler.tick();
    await settle();
    assert.equal(executor.started.length, 1);
    now += 60_000;
    await scheduler.tick();
    await settle();
    assert.equal(executor.started.length, 1, 'second occurrence skipped while the first runs');
    assert.equal(scheduler.getJob(job.id).nextRunAt, now + 60_000);
  });

  test('times out a run, cancels it and counts a failure', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, timeoutSeconds: 60 });
    scheduler.start();
    await scheduler.tick();
    const realSetTimeout = global.setTimeout;
    // Make the 60s timeout fire immediately for this test.
    (global as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms: number) =>
      realSetTimeout(fn, ms >= 60_000 ? 0 : ms)) as typeof setTimeout;
    try {
      await scheduler.runNow(job.id);
      await new Promise((resolve) => realSetTimeout(resolve, 50));
    } finally {
      (global as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
    assert.equal(executor.started[0].cancelled, true);
    const [run] = scheduler.listRuns(job.id);
    assert.equal(run.status, 'timed_out');
    assert.match(run.error ?? '', /Timed out after 1 min/);
    assert.equal(scheduler.getJob(job.id).consecutiveFailures, 1);
  });

  test('pauses a job after five failed runs in a row and resumes on enable', async () => {
    const scheduler = makeScheduler();
    executor.autoResolve = { status: 'failed', summary: null, error: 'boom' };
    const job = scheduler.createJob(baseJob);
    for (let index = 0; index < 5; index += 1) {
      await scheduler.runNow(job.id);
      await settle();
    }
    const paused = scheduler.getJob(job.id);
    assert.equal(paused.autoPaused, true);
    assert.equal(paused.nextRunAt, null);
    assert.match(paused.lastError ?? '', /Paused after 5 failed runs/);

    const resumed = scheduler.updateJob(job.id, { enabled: true });
    assert.equal(resumed.autoPaused, false);
    assert.equal(resumed.consecutiveFailures, 0);
    assert.equal(resumed.nextRunAt, now + 3_600_000);
  });

  test('a one-shot job runs once and then turns itself off', async () => {
    const scheduler = makeScheduler();
    executor.autoResolve = { status: 'succeeded', summary: 'done', error: null };
    const job = scheduler.createJob({ ...baseJob, schedule: { kind: 'at', at: now + 1000 } });
    scheduler.start();
    await scheduler.tick();
    now += 1000;
    await scheduler.tick();
    await settle();
    const after = scheduler.getJob(job.id);
    assert.equal(executor.started.length, 1);
    assert.equal(after.enabled, false);
    assert.equal(after.nextRunAt, null);
    assert.throws(() => scheduler.updateJob(job.id, { enabled: true }), /Pick a new time/);
    // Editing other fields with the same (past) time is fine.
    assert.equal(scheduler.updateJob(job.id, { name: 'Renamed', schedule: { kind: 'at', at: now } }).name, 'Renamed');
  });

  test('refuses a manual run while one is active and supports cancel', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob(baseJob);
    await scheduler.runNow(job.id);
    await settle();
    await assert.rejects(() => scheduler.runNow(job.id), ScheduledJobConflictError);
    assert.equal(scheduler.cancelActiveRun(job.id), true);
    await settle();
    const [run] = scheduler.listRuns(job.id);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.trigger, 'manual');
    assert.equal(scheduler.getJob(job.id).consecutiveFailures, 0, 'a user cancel is not a failure');
  });

  test('records a start failure as a failed run', async () => {
    const scheduler = makeScheduler();
    executor.failStart = new Error('Agent runtime "kiro" is not available');
    const job = scheduler.createJob(baseJob);
    await scheduler.runNow(job.id);
    await settle();
    const [run] = scheduler.listRuns(job.id);
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /not available/);
  });

  test('only one scheduler holds the lease for a data directory', async () => {
    const first = makeScheduler({ instanceId: 'instance-a' });
    const second = makeScheduler({ instanceId: 'instance-b' });
    first.createJob({ ...baseJob, schedule: { kind: 'every', everySeconds: 60 } });
    first.start();
    await first.tick();
    second.start();
    await second.tick();
    now += 60_000;
    await first.tick();
    await second.tick();
    await settle();
    assert.equal(executor.started.length, 1);
    assert.equal(first.status().active, true);
    assert.equal(second.status().active, false);
  });

  test('marks runs left by a dead process as interrupted', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob(baseJob);
    getDb().prepare(`INSERT INTO scheduled_job_runs (id, job_id, workspace_id, trigger, status, started_at, claimed_by)
      VALUES ('run-stale', ?, 'ws-a', 'scheduled', 'running', 1, 'dead-process')`).run(job.id);
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(scheduler.getRun('run-stale').status, 'interrupted');
  });

  test('replays undelivered notifications until acknowledged', async () => {
    const scheduler = makeScheduler();
    executor.autoResolve = { status: 'succeeded', summary: 'Result', error: null };
    const job = scheduler.createJob(baseJob);
    const run = await scheduler.runNow(job.id);
    await settle();
    const pending = scheduler.pendingNotifications();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].runId, run.id);
    assert.equal(pending[0].phase, 'finished');
    assert.equal(pending[0].summary, 'Result');
    assert.equal(scheduler.acknowledgeNotification(run.id), true);
    assert.deepEqual(scheduler.pendingNotifications(), []);
  });

  test('a run that needs approval publishes attention and wakes the app', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob({ ...baseJob, notify: false });
    await scheduler.runNow(job.id);
    await settle();
    executor.started[0].hooks.onAttention('approval');
    const attention = published.find((event) => event.phase === 'attention');
    assert.equal(attention?.attention, 'approval');
    assert.equal(wakes, 1);
    assert.equal(scheduler.pendingNotifications()[0]?.phase, 'attention');
  });

  test('does not wake the app while a notifier is connected', async () => {
    const scheduler = makeScheduler();
    events.subscribe({ notifier: true, send: () => {} });
    executor.autoResolve = { status: 'succeeded', summary: null, error: null };
    const job = scheduler.createJob(baseJob);
    await scheduler.runNow(job.id);
    await settle();
    assert.equal(wakes, 0);
  });

  test('changing the agent profile starts a new persistent thread', async () => {
    const scheduler = makeScheduler();
    executor.autoResolve = { status: 'succeeded', summary: null, error: null };
    const job = scheduler.createJob({ ...baseJob, sessionMode: 'persistent' });
    await scheduler.runNow(job.id);
    await settle();
    assert.equal(scheduler.getJob(job.id).persistentNodeId, 'node-1');
    assert.equal(scheduler.updateJob(job.id, { prompt: 'New prompt' }).persistentNodeId, 'node-1');
    assert.equal(scheduler.updateJob(job.id, { runtimeId: 'pi' }).persistentNodeId, null);
  });

  test('stop() records in-flight runs as interrupted', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob(baseJob);
    await scheduler.runNow(job.id);
    await settle();
    await scheduler.stop();
    const [run] = scheduler.listRuns(job.id);
    assert.equal(run.status, 'interrupted');
    assert.equal(executor.started[0].cancelled, true);
  });

  test('deleting a job cancels its active run', async () => {
    const scheduler = makeScheduler();
    const job = scheduler.createJob(baseJob);
    await scheduler.runNow(job.id);
    await settle();
    scheduler.deleteJob(job.id);
    await settle();
    assert.equal(executor.started[0].cancelled, true);
    assert.deepEqual(scheduler.listJobs(), []);
  });

  test('preview reports the next runs or the validation error', () => {
    const scheduler = makeScheduler();
    assert.deepEqual(scheduler.preview({ kind: 'every', everySeconds: 120 }).nextRuns, [now + 120_000, now + 240_000, now + 360_000]);
    const invalid = scheduler.preview({ kind: 'cron', expression: '61 * * * *', timezone: null });
    assert.equal(invalid.valid, false);
    assert.match(invalid.error ?? '', /minute/);
  });
});
