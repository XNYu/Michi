import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScheduledJobRunEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord, type SchedulerLease } from '../src/services/scheduledJobs/repository';
import { ScheduledJobConflictError, ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunHandle, type ScheduledRunHooks, type ScheduledRunOutcome } from '../src/services/scheduledJobs/scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const success: ScheduledRunOutcome = { status: 'succeeded', summary: 'late result', error: null };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(done => setImmediate(done)); };

interface Execution {
  run: ScheduledJobRunRecord;
  hooks: ScheduledRunHooks;
  stopped: boolean;
  cancels: number;
  finish(outcome?: ScheduledRunOutcome): void;
}
class PendingExecutor implements ScheduledJobExecutor {
  processExitStopsExecution = true;
  started: Execution[] = [];
  startGate: Promise<void> | null = null;
  cancelSettles = false;
  cancelThrows = false;
  async start(job: ScheduledJobRecord, run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    const done = deferred<ScheduledRunOutcome>();
    const execution: Execution = { run, hooks, stopped: false, cancels: 0,
      finish: (outcome = success) => { execution.stopped = true; done.resolve(outcome); } };
    this.started.push(execution);
    const nodeId = `node-${run.id}`;
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES (?, ?, 'chat', 'idle', 1)`).run(nodeId, job.workspaceId);
    // The executor can already own live work while start() has not returned.
    if (this.startGate) await this.startGate;
    return { nodeId, treeId: null, turnId: `turn-${run.id}`, done: done.promise,
      cancel: () => {
        execution.cancels++;
        if (this.cancelThrows) throw new Error('native cancel failed');
        if (this.cancelSettles) execution.finish({ status: 'cancelled', summary: null, error: null });
      } };
  }
  get openHandles() { return this.started.filter(run => !run.stopped).length; }
}

describe('scheduled execution admission and ownership', () => {
  let dir: string;
  let now: number;
  let executor: PendingExecutor;
  let repo: ScheduledJobsRepository;
  let events: ScheduledJobEventBus;
  let published: ScheduledJobRunEvent[];
  let schedulers: ScheduledJobScheduler[];
  let releaseGates: Array<() => void>;
  let jobSeq: number;
  const fields = { workspaceId: 'w', name: 'Task', prompt: 'Do work', schedule: { kind: 'every', everySeconds: 60 } };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-scheduler-ownership-'));
    process.env.MICHI_DATA_DIR = dir;
    closeDb(); initDb();
    getDb().prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w', 'W', 1, 1)").run();
    now = Date.parse('2026-10-23T00:00:00Z'); jobSeq = 0;
    executor = new PendingExecutor(); repo = new ScheduledJobsRepository(); events = new ScheduledJobEventBus(() => now);
    published = []; events.subscribe({ send: event => published.push(event) });
    schedulers = []; releaseGates = [];
  });
  afterEach(async () => {
    releaseGates.forEach(release => release());
    await flush();
    executor.started.forEach(run => run.finish());
    await flush();
    for (const scheduler of schedulers) await scheduler.stop();
    await flush(); closeDb(); fs.rmSync(dir, { recursive: true, force: true });
  });
  function scheduler(holder: string, maxConcurrentRuns = 1) {
    const scheduler = new ScheduledJobScheduler({ repository: repo, executor, events, clock: () => now,
      instanceId: holder, workspaceExists: () => true, runtimeExists: () => true, leaseTtlMs: 90_000,
      pollIntervalMs: 60_000, cancelGraceMs: 5, maxConcurrentRuns, createId: () => `job-${++jobSeq}` });
    schedulers.push(scheduler); return scheduler;
  }
  function lease(): SchedulerLease {
    return getDb().prepare('SELECT holder, generation FROM scheduler_lease WHERE id = 1').get() as unknown as SchedulerLease;
  }
  function claims() { return (getDb().prepare('SELECT COUNT(*) AS n FROM scheduler_execution_claims').get() as { n: number }).n; }

  test('manual/manual shares the cap, including start pending and cancellation not settled', async () => {
    const a = scheduler('a');
    const first = a.createJob({ ...fields, enabled: false });
    const second = a.createJob(fields);
    const gate = deferred<void>(); executor.startGate = gate.promise; releaseGates.push(() => gate.resolve());
    await a.runNow(first.id);
    await assert.rejects(a.runNow(second.id), ScheduledJobConflictError);
    assert.equal(executor.openHandles, 1); assert.equal(claims(), 1);
    assert.equal(a.cancelActiveRun(first.id), true);
    await assert.rejects(a.runNow(second.id), /not confirmed it stopped/);
    gate.resolve(); await flush();
    assert.equal(executor.started[0].cancels, 1);
    assert.equal(executor.openHandles, 1, 'cancel request alone is not stopped');
    await assert.rejects(a.runNow(second.id), ScheduledJobConflictError);
    executor.started[0].finish(); await flush();
    assert.equal(a.listRuns(first.id)[0].status, 'cancelled');
    await a.runNow(second.id); await flush();
    assert.equal(executor.openHandles, 1); assert.equal(claims(), 1);
  });

  test('scheduled/manual shares admission and full capacity retains the scheduled due time', async () => {
    const a = scheduler('a');
    const first = a.createJob(fields); const second = a.createJob(fields);
    a.start(); await a.tick(); now += 60_000; await a.tick(); await flush();
    assert.equal(executor.openHandles, 1);
    await assert.rejects(a.runNow(second.id), /concurrency limit/);
    const due = a.getJob(second.id).nextRunAt;
    assert.equal(due, now);
    executor.started[0].finish(); await flush(); await a.tick(); await flush();
    assert.equal(executor.started.length, 2); assert.equal(executor.openHandles, 1);
    assert.equal(a.getJob(first.id).lastStatus, 'succeeded');
  });

  test('two scheduler owners cannot admit together and takeover waits for real old done', async () => {
    const a = scheduler('a'); const b = scheduler('b');
    const first = a.createJob({ ...fields, sessionMode: 'persistent' }); const second = a.createJob(fields);
    const oldRun = await a.runNow(first.id); await flush();
    const oldFence = lease();
    await assert.rejects(b.runNow(second.id), /Another Michi process/);
    now += 90_001; b.start(); await b.tick(); await flush();
    assert.equal(b.getRun(oldRun.id).status, 'interrupted');
    assert.equal(executor.openHandles, 1); assert.equal(claims(), 1);
    assert.equal(b.status().blockedExecutions?.[0].runId, oldRun.id);
    await assert.rejects(b.runNow(second.id), /not confirmed it stopped/);
    const eventsBefore = published.length;
    executor.started[0].hooks.onAttention('approval');
    await a.tick(); await flush();
    assert.equal(executor.started[0].cancels, 1);
    assert.equal(executor.started[0].hooks.signal?.aborted, true);
    assert.equal(repo.markAttention(oldRun.id, 'input', oldFence, now), false);
    assert.equal(repo.attachRunTarget(oldRun.id, { nodeId: 'foreign', treeId: null, turnId: null }, oldFence, now), false);
    assert.equal(repo.finishRun(oldRun.id, oldFence, { status: 'succeeded', finishedAt: now, summary: 'stale', error: null, notify: true }), false);
    assert.throws(() => b.confirmExecutionStopped(oldRun.id, { executionStopped: true }), /previous Michi process/);
    assert.equal(published.length, eventsBefore, 'lost owner cannot publish attention or result');
    await assert.rejects(b.runNow(second.id), ScheduledJobConflictError);
    executor.started[0].finish(); await flush();
    assert.equal(b.getRun(oldRun.id).status, 'interrupted');
    assert.equal(published.length, eventsBefore);
    await b.runNow(second.id); await flush();
    assert.equal(executor.openHandles, 1); assert.equal(claims(), 1);
  });

  test('lease expiry fences an old generation even if the same holder reacquires', async () => {
    const a = scheduler('same'); const job = a.createJob(fields);
    const first = await a.runNow(job.id); await flush(); const old = lease();
    now += 90_001; await a.tick(); await flush();
    assert.ok(lease().generation > old.generation);
    assert.equal(executor.started[0].cancels, 1);
    assert.equal(a.getRun(first.id).status, 'interrupted');
    executor.started[0].finish(); await flush();
    const second = await a.runNow(job.id); await flush();
    repo.releaseExecution(second.id, old);
    assert.equal(claims(), 1, 'old holder/generation cannot release a new claim');
  });

  for (const action of ['stop', 'delete', 'cancel', 'takeover'] as const) {
    test(`late executor start after ${action} is cancelled and remains reserved until done`, async () => {
      const a = scheduler('a'); const b = scheduler('b');
      const first = a.createJob({ ...fields, sessionMode: 'persistent' }); const second = a.createJob(fields);
      const gate = deferred<void>(); executor.startGate = gate.promise; releaseGates.push(() => gate.resolve());
      const run = await a.runNow(first.id); await flush();
      if (action === 'stop') await a.stop();
      else if (action === 'delete') a.deleteJob(first.id);
      else if (action === 'cancel') a.cancelActiveRun(first.id);
      else { now += 90_001; b.start(); await b.tick(); await a.tick(); }
      const next = action === 'stop' || action === 'takeover' ? b : a;
      await assert.rejects(next.runNow(second.id), ScheduledJobConflictError);
      gate.resolve(); await flush();
      assert.equal(executor.started[0].cancels, 1); assert.equal(executor.openHandles, 1);
      assert.equal(claims(), 1); assert.equal(published.filter(event => event.phase === 'started').length, 0);
      if (action !== 'delete') {
        assert.equal(a.getRun(run.id).nodeId, null, 'late target is not attached');
        assert.equal(a.getJob(first.id).persistentNodeId, null);
      }
      executor.started[0].finish(); await flush();
      await next.runNow(second.id); await flush();
      assert.equal(executor.openHandles, 1); assert.equal(claims(), 1);
    });
  }

  test('timeout/cancel failure records a terminal result but retains actual occupancy', async () => {
    const a = scheduler('a'); const first = a.createJob(fields); const second = a.createJob(fields);
    repo.updateJob(first.id, { timeoutSeconds: 0.01 }); executor.cancelThrows = true;
    await a.runNow(first.id); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(a.listRuns(first.id)[0].status, 'timed_out');
    assert.equal(executor.openHandles, 1); assert.equal(claims(), 1);
    await assert.rejects(a.runNow(second.id), /not confirmed it stopped/);
    assert.equal(a.status().blockedExecutions?.length, 1);
    executor.started[0].finish(); await flush();
    await a.runNow(second.id); await flush(); assert.equal(executor.openHandles, 1);
  });

  test('timeout while start is pending fences the late target and retains occupancy', async () => {
    const a = scheduler('a'); const first = a.createJob(fields); const second = a.createJob(fields);
    const gate = deferred<void>(); executor.startGate = gate.promise; releaseGates.push(() => gate.resolve());
    repo.updateJob(first.id, { timeoutSeconds: 0.01 });
    const run = await a.runNow(first.id); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(a.getRun(run.id).status, 'timed_out'); assert.equal(claims(), 1);
    gate.resolve(); await flush();
    assert.equal(executor.started[0].cancels, 1); assert.equal(a.getRun(run.id).nodeId, null);
    await assert.rejects(a.runNow(second.id), ScheduledJobConflictError);
    executor.started[0].finish(); await flush();
    assert.equal(a.getRun(run.id).status, 'timed_out');
    await a.runNow(second.id); assert.equal(executor.openHandles, 1);
  });

  test('target persistence failure cancels but cannot release an unresolved live executor', async () => {
    const original = repo.attachRunTarget.bind(repo);
    repo.attachRunTarget = () => { throw new Error('injected target write failure'); };
    const a = scheduler('a'); const first = a.createJob(fields); const second = a.createJob(fields);
    const run = await a.runNow(first.id); await flush();
    assert.equal(a.getRun(run.id).status, 'failed'); assert.equal(executor.openHandles, 1);
    assert.equal(executor.started[0].cancels, 1); assert.equal(claims(), 1);
    assert.equal(a.status().blockedExecutions?.[0].runId, run.id);
    await assert.rejects(a.runNow(second.id), /not confirmed it stopped/);
    repo.attachRunTarget = original; executor.started[0].finish(); await flush();
    await a.runNow(second.id); assert.equal(executor.openHandles, 1);
  });

  test('reservation release failure retains its end acknowledgment and retries on tick', async () => {
    const a = scheduler('a'); const first = a.createJob(fields); const second = a.createJob(fields);
    await a.runNow(first.id); await flush();
    const release = repo.releaseExecution.bind(repo); let fail = true;
    repo.releaseExecution = (...args) => { if (fail) throw new Error('injected release write failure'); release(...args); };
    executor.started[0].finish(); await flush();
    assert.equal(executor.openHandles, 0); assert.equal(claims(), 1);
    assert.match(a.status().blockedExecutions?.[0].reason ?? '', /reservation could not be cleared/);
    fail = false; await a.tick(); await flush(); assert.equal(claims(), 0);
    await a.runNow(second.id); assert.equal(executor.openHandles, 1);
  });

  for (const safe of [true, false]) {
    test(`real process exit and SQLite reopen ${safe ? 'reaps contained work' : 'requires visible explicit recovery for external work'}`, async () => {
      // A real child writes a live claim and exits without stop()/done. This
      // never uses the user's data directory or contacts an agent/provider.
      closeDb();
      const child = execFileSync(process.execPath, ['--require', 'ts-node/register/transpile-only', '-e', `
        const { initDb } = require('./src/services/db'); initDb();
        const { ScheduledJobsRepository } = require('./src/services/scheduledJobs/repository');
        const { ScheduledJobScheduler } = require('./src/services/scheduledJobs/scheduler');
        const { ScheduledJobEventBus } = require('./src/services/scheduledJobs/events');
        const executor = { processExitStopsExecution: ${safe}, start: async () => new Promise(() => {}) };
        const scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
          events: new ScheduledJobEventBus(), workspaceExists: () => true, runtimeExists: () => true,
          clock: () => ${now}, instanceId: 'child', createId: () => 'child-job' });
        const job = scheduler.createJob(${JSON.stringify({ ...fields, enabled: false })});
        scheduler.runNow(job.id).then(run => { process.stdout.write(JSON.stringify({ id: run.id, pid: process.pid })); process.exit(0); });
      `], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, MICHI_DATA_DIR: dir }, encoding: 'utf8', timeout: 25_000 });
      const orphan = JSON.parse(child) as { id: string; pid: number };
      initDb(); now += 90_001;
      const a = scheduler('replacement'); a.start(); await a.tick(); await flush();
      assert.equal(a.getRun(orphan.id).status, 'interrupted');
      if (safe) {
        assert.equal(claims(), 0); assert.deepEqual(a.status().blockedExecutions, []);
      } else {
        assert.equal(claims(), 1); assert.equal(a.status().blockedExecutions?.[0].runId, orphan.id);
        const other = a.createJob(fields);
        await assert.rejects(a.runNow(other.id), /not confirmed it stopped/);
        assert.throws(() => a.confirmExecutionStopped(orphan.id, {}), /Confirm/);
        a.confirmExecutionStopped(orphan.id, { executionStopped: true });
        assert.equal(claims(), 0);
      }
      await a.runNow('child-job'); await flush(); assert.equal(executor.openHandles, 1);
    });
  }

  test('PID reuse or unknown legacy identity stays quarantined and visible', async () => {
    const a = scheduler('a'); const job = a.createJob(fields);
    getDb().prepare(`INSERT INTO scheduler_execution_claims
      (run_id, job_id, holder, generation, process_id, acquired_at, workspace_id, process_exit_safe, quarantined_at, reason)
      VALUES ('legacy', ?, 'older', 0, ?, ?, 'w', 1, ?, 'Unconfirmed legacy execution')`).run(job.id, process.pid, now, now);
    a.start(); await a.tick();
    assert.equal(claims(), 1, 'live/reused PID is not proof that the old work stopped');
    assert.throws(() => a.confirmExecutionStopped('legacy', { executionStopped: true }), ScheduledJobConflictError);
    getDb().prepare("UPDATE scheduler_execution_claims SET process_id = NULL WHERE run_id = 'legacy'").run();
    assert.equal(a.status().blockedExecutions?.[0].reason, 'Unconfirmed legacy execution');
    a.confirmExecutionStopped('legacy', { executionStopped: true });
    await a.runNow(job.id); assert.equal(executor.openHandles, 1);
  });
});
