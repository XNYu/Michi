import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { MetaAgentGuardError, metaAgentCatalogUnavailable } from '../src/agents/metaAgentGuard';
import type { AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { retryMetaAgentGuard } from '../src/services/metaAgent/guardStatus';
import { metaAgentInfo, updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { createMaintenanceConfig } from '../src/services/pages/maintenanceRepository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunHandle, type ScheduledRunHooks } from '../src/services/scheduledJobs/scheduler';

const OWNER = 'local-user';

function fakeRuntime(id: string): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: false,
      saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {},
    async newSession() { throw new Error('not used'); },
    async releaseSession() {},
    async shutdown() {},
  };
}
for (const id of ['claude', 'pi', 'codex', 'kiro']) registerRuntime(fakeRuntime(id));

/** How one run ends: `reject` is a session that failed to open, `fail` a turn that ended in error. */
type Behavior = { kind: 'reject'; error: unknown } | { kind: 'fail'; error: string } | { kind: 'succeed' };

class ScriptedExecutor implements ScheduledJobExecutor {
  behaviors: Behavior[] = [];
  started: Array<{ hooks: ScheduledRunHooks }> = [];

  async start(job: ScheduledJobRecord, _run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    const index = this.started.length + 1;
    this.started.push({ hooks });
    const behavior = this.behaviors.shift() ?? { kind: 'succeed' };
    if (behavior.kind === 'reject') throw behavior.error;
    const treeId = `guard-tree-${index}`;
    const nodeId = `guard-node-${index}`;
    getDb().prepare('INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES(?,?,?,?,?)')
      .run(treeId, job.workspaceId, nodeId, now, now);
    getDb().prepare(`INSERT INTO nodes(id,workspace_id,tree_id,kind,status,minimized,created_at)
      VALUES(?,?,?,'chat','idle',0,?)`).run(nodeId, job.workspaceId, treeId, now);
    return {
      nodeId, treeId, turnId: `guard-turn-${index}`, cancel() {},
      done: Promise.resolve(behavior.kind === 'fail'
        ? { status: 'failed' as const, summary: null, error: behavior.error }
        : { status: 'succeeded' as const, summary: 'done', error: null }),
    };
  }
}

let tmpDir: string;
let now: number;
let priorDataDir: string | undefined;
let priorCloud: string | undefined;

function flush(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail('condition did not become true');
}

function completeSource(turnId: string): void {
  const nodeId = `source-node-${turnId}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?, 'ws', 'chat', 'idle', ?)").run(nodeId, now);
  let turn = createDurableTurn({ turnId, assistantId: `assistant-${turnId}`, nodeId, workspaceId: 'ws', displayUserText: 'question', startedAt: now });
  beginTurn(turn);
  turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'an answer worth keeping' } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
}

describe('scheduled maintenance and the Meta agent restriction check', () => {
  beforeEach(() => {
    priorDataDir = process.env.MICHI_DATA_DIR;
    priorCloud = process.env.MICHI_CLOUD;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-guard-scheduler-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    now = Date.parse('2026-10-23T02:00:00Z');
    mock.method(Date, 'now', () => now);
    getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('ws', 'Workspace', now, now);
  });

  afterEach(() => {
    mock.restoreAll();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
    if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  });

  function fixture(runtimeId: string) {
    const executor = new ScriptedExecutor();
    let nextJob = 0;
    const scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
      events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: () => true,
      clock: () => now, instanceId: 'guard-test-worker', createId: () => `job-${++nextJob}`, pollIntervalMs: 600_000 });
    const job = scheduler.createJob({ workspaceId: 'ws', name: 'Space maintenance', prompt: 'Maintain relevant spaces',
      schedule: { kind: 'every', everySeconds: 60 }, permissionMode: 'trust', sessionMode: 'fresh',
      conversationUpdates: true, notify: false });
    createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: OWNER, jobId: job.id, now, enabled: true });
    updateMetaAgentSettings({ runtimeId });
    getDb().prepare('UPDATE scheduled_jobs SET conversation_cursor=0 WHERE id=?').run(job.id);
    getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=0 WHERE job_id=?').run(job.id);
    completeSource('source-a');
    return { scheduler, executor, jobId: job.id };
  }

  async function runOnce(scheduler: ScheduledJobScheduler, jobId: string): Promise<void> {
    await scheduler.runNow(jobId);
    await until(() => scheduler.getJob(jobId).activeRunId === null);
  }

  /** Makes the job due and runs one scheduler tick. */
  async function dueTick(scheduler: ScheduledJobScheduler, jobId: string): Promise<void> {
    await scheduler.tick();
    now += 61_000 * 2 ** Math.max(0, scheduler.getJob(jobId).consecutiveFailures - 1);
    if (scheduler.listJobs().some(job => job.id === jobId)) getDb().prepare('UPDATE scheduled_jobs SET next_run_at=? WHERE id=?').run(now - 1, jobId);
    await scheduler.tick();
    await until(() => scheduler.getJob(jobId).activeRunId === null);
  }

  // How each runtime surfaces a failed check to the scheduled run.
  const surfaced: Array<{ runtimeId: string; how: string; behavior: (error: MetaAgentGuardError) => Behavior }> = [
    { runtimeId: 'codex', how: 'its session refuses to open', behavior: (error) => ({ kind: 'reject', error }) },
    { runtimeId: 'kiro', how: 'its session refuses to open', behavior: (error) => ({ kind: 'reject', error }) },
    { runtimeId: 'kiro', how: 'its turn ends with the error', behavior: (error) => ({ kind: 'fail', error: error.message }) },
    { runtimeId: 'claude', how: 'its turn ends with the error', behavior: (error) => ({ kind: 'fail', error: error.message }) },
    { runtimeId: 'pi', how: 'its turn ends with the error', behavior: (error) => ({ kind: 'fail', error: error.message }) },
  ];
  for (const { runtimeId, how, behavior } of surfaced) {
    test(`${runtimeId}: a failed check is recorded with the extra tools when ${how}`, async () => {
      const { scheduler, executor, jobId } = fixture(runtimeId);
      try {
        const error = new MetaAgentGuardError({ runtimeId, toolset: 'maintenance', unexpectedTools: ['native:Bash', 'mcp_server:github'] });
        executor.behaviors.push(behavior(error));
        await runOnce(scheduler, jobId);
        const job = scheduler.getJob(jobId);
        assert.equal(job.lastStatus, 'failed');
        assert.equal(job.lastError, error.message);
        assert.deepEqual(metaAgentInfo().guard.maintenance,
          { state: 'failed', runtimeId, toolset: 'maintenance', unexpectedTools: ['native:Bash', 'mcp_server:github'], checkedAt: now });
        assert.equal(metaAgentInfo().guard.chat, null);
      } finally {
        await scheduler.stop();
      }
    });
  }

  test('a check that never got a catalog keeps its detail', async () => {
    const { scheduler, executor, jobId } = fixture('kiro');
    try {
      executor.behaviors.push({ kind: 'reject', error: metaAgentCatalogUnavailable('kiro', 'maintenance', 'Kiro published no tool catalog within 30s of selecting the agent') });
      await runOnce(scheduler, jobId);
      assert.deepEqual(metaAgentInfo().guard.maintenance, { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance',
        unexpectedTools: [], detail: 'Kiro published no tool catalog within 30s of selecting the agent', checkedAt: now });
    } finally {
      await scheduler.stop();
    }
  });

  test('a run whose turn succeeded records ok; other failures leave the record alone', async () => {
    const { scheduler, executor, jobId } = fixture('pi');
    try {
      executor.behaviors.push({ kind: 'fail', error: 'Pi provider rate limited' });
      await runOnce(scheduler, jobId);
      assert.equal(metaAgentInfo().guard.maintenance, null);
      executor.behaviors.push({ kind: 'succeed' });
      await runOnce(scheduler, jobId);
      assert.deepEqual(metaAgentInfo().guard.maintenance,
        { state: 'ok', runtimeId: 'pi', toolset: 'maintenance', unexpectedTools: [], checkedAt: now });
      executor.behaviors.push({ kind: 'reject', error: new Error('Pi provider is not configured') });
      await runOnce(scheduler, jobId);
      assert.equal(metaAgentInfo().guard.maintenance?.state, 'ok');
    } finally {
      await scheduler.stop();
    }
  });

  test('a failed check holds scheduled runs until a retry, which starts one at once', async () => {
    const { scheduler, executor, jobId } = fixture('kiro');
    try {
      const error = new MetaAgentGuardError({ runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['desk_now'] });
      executor.behaviors.push({ kind: 'reject', error });
      await runOnce(scheduler, jobId);
      scheduler.start();
      assert.equal(executor.started.length, 1);

      for (let i = 0; i < 3; i += 1) await dueTick(scheduler, jobId);
      assert.equal(executor.started.length, 1, 'held runs never open a session');
      const held = scheduler.getJob(jobId);
      assert.equal(held.lastStatus, 'failed');
      assert.equal(held.lastError, error.message);
      assert.equal(held.consecutiveFailures, 1, 'held runs do not count toward the auto-pause');
      assert.equal(held.nextRunAt, null, 'no per-workspace schedule is created');

      executor.behaviors.push({ kind: 'succeed' });
      retryMetaAgentGuard(['maintenance']);
      await until(() => executor.started.length === 2);
      await until(() => scheduler.getJob(jobId).activeRunId === null);
      assert.equal(metaAgentInfo().guard.maintenance?.state, 'ok');
      await dueTick(scheduler, jobId);
      assert.equal(executor.started.length, 3, 'scheduled runs resume');
    } finally {
      await scheduler.stop();
    }
  });

  test('retrying the chat toolset does not start maintenance', async () => {
    const { scheduler, executor, jobId } = fixture('kiro');
    try {
      executor.behaviors.push({ kind: 'reject', error: new MetaAgentGuardError({ runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['x'] }) });
      await runOnce(scheduler, jobId);
      scheduler.start();
      retryMetaAgentGuard(['chat']);
      await flush();
      assert.equal(executor.started.length, 1);
      assert.equal(metaAgentInfo().guard.maintenance?.state, 'failed');
    } finally {
      await scheduler.stop();
    }
  });

  test('a Meta agent settings change releases the hold', async () => {
    const { scheduler, executor, jobId } = fixture('claude');
    try {
      executor.behaviors.push({ kind: 'fail', error: new MetaAgentGuardError({ runtimeId: 'claude', toolset: 'maintenance', unexpectedTools: ['native:Bash'] }).message });
      await runOnce(scheduler, jobId);
      scheduler.start();
      await dueTick(scheduler, jobId);
      assert.equal(executor.started.length, 1);

      updateMetaAgentSettings({ modelId: 'claude-other-model' });
      assert.equal(metaAgentInfo().guard.maintenance, null, 'the failure belonged to the old profile');
      await dueTick(scheduler, jobId);
      assert.equal(executor.started.length, 2);

      executor.behaviors.push({ kind: 'reject', error: new MetaAgentGuardError({ runtimeId: 'claude', toolset: 'maintenance', unexpectedTools: ['native:Bash'] }) });
      await dueTick(scheduler, jobId);
      assert.equal(executor.started.length, 3);
      updateMetaAgentSettings({ runtimeId: 'pi' });
      await dueTick(scheduler, jobId);
      assert.equal(executor.started.length, 4, 'a failure on another runtime no longer holds runs');
    } finally {
      await scheduler.stop();
    }
  });

  test('ordinary scheduled jobs are never held', async () => {
    const { scheduler, executor, jobId } = fixture('kiro');
    try {
      executor.behaviors.push({ kind: 'reject', error: new MetaAgentGuardError({ runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['x'] }) });
      await runOnce(scheduler, jobId);
      scheduler.start();
      const plain = scheduler.createJob({ workspaceId: 'ws', name: 'Digest', prompt: 'Summarize',
        schedule: { kind: 'every', everySeconds: 60 }, runtimeId: 'kiro' });
      await dueTick(scheduler, plain.id);
      assert.equal(executor.started.length, 2);
    } finally {
      await scheduler.stop();
    }
  });
});
