import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import type { AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { metaAgentOverview, setMetaAgentPaused } from '../src/services/metaAgent/overview';
import { runMetaAgentRoundNow } from '../src/services/metaAgent/runNow';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { closeDb, getDb, initDb } from '../src/services/db';
import { createMaintenanceConfig, getMaintenancePlan, listMaintenanceBacklog, markMaintenanceSourceAttention } from '../src/services/pages/maintenanceRepository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import type { ScheduledJobRecord, ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
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
registerRuntime(fakeRuntime('pi'));

let tmpDir: string;
let now: number;
let nextId = 0;

interface StartedRun { hooks: ScheduledRunHooks; resolve(): void }

class Executor implements ScheduledJobExecutor {
  started: StartedRun[] = [];
  async start(job: ScheduledJobRecord, _run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    const index = this.started.length + 1;
    const nodeId = `maintenance-node-${index}`;
    const treeId = `maintenance-tree-${index}`;
    getDb().prepare('INSERT INTO trees(id,workspace_id,root_node_id,last_active_at,created_at) VALUES(?,?,?,?,?)').run(treeId, job.workspaceId, nodeId, now, now);
    getDb().prepare(`INSERT INTO nodes(id,workspace_id,tree_id,kind,status,minimized,created_at) VALUES(?,?,?,'chat','idle',0,?)`).run(nodeId, job.workspaceId, treeId, now);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    this.started.push({ hooks, resolve: settle });
    return { nodeId, treeId, turnId: `maintenance-turn-${index}`, done: done.then(() => ({ status: 'succeeded' as const, summary: 'done', error: null })), cancel: () => settle() };
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
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
  let turn = createDurableTurn({ turnId, assistantId: `assistant-${turnId}`, nodeId, workspaceId: 'ws', displayUserText: 'Plan the rollout', startedAt: now });
  beginTurn(turn);
  turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'Rollout plan' } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-attention-retry-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  now = Date.parse('2026-10-23T02:00:00Z');
  mock.method(Date, 'now', () => now);
  nextId = 0;
  getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('ws', 'Workspace', now, now);
});

afterEach(() => {
  mock.restoreAll();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Retry queues a batch held for attention again, and the next run resumes that batch', async () => {
  const executor = new Executor();
  const scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: (runtimeId) => runtimeId === 'pi',
    clock: () => now, instanceId: 'attention-test-worker', createId: () => `job-${++nextId}`, pollIntervalMs: 60_000 });
  const job = scheduler.createJob({ workspaceId: 'ws', name: 'Space maintenance', prompt: 'Maintain relevant spaces',
    schedule: { kind: 'every', everySeconds: 60 }, permissionMode: 'trust', sessionMode: 'fresh', conversationUpdates: true, notify: false });
  createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: OWNER, jobId: job.id, now, enabled: true });
  updateMetaAgentSettings({ runtimeId: 'pi' });
  getDb().prepare('UPDATE scheduled_jobs SET conversation_cursor=0 WHERE id=?').run(job.id);
  getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=0 WHERE job_id=?').run(job.id);
  completeSource('turn-a');

  await scheduler.runNow(job.id);
  await until(() => executor.started[0]?.hooks.maintenanceContext !== undefined);
  const planId = executor.started[0].hooks.maintenanceContext!.planId;
  markMaintenanceSourceAttention({ planId, ownerUserId: OWNER, sourceTurnId: 'turn-a', reason: 'contentTooLarge: the turn is over 2 MB', now });
  executor.started[0].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  assert.equal(getMaintenancePlan(planId, OWNER)!.state, 'attention');
  assert.equal(listMaintenanceBacklog('ws', OWNER).attentionSources, 1);

  now += 60_000;
  setMetaAgentPaused({ scheduler, ownerUserId: OWNER, paused: false, clock: () => now });
  const plan = getMaintenancePlan(planId, OWNER)!;
  assert.equal(plan.state, 'processing');
  assert.deepEqual(plan.sources.map((source) => source.state), ['routing']);
  assert.equal(listMaintenanceBacklog('ws', OWNER).attentionSources, 0);
  assert.equal(metaAgentOverview({ ownerUserId: OWNER, now }).cursors[0].problem?.reason === 'needs-attention', false);

  // Retry then runs one round through Update's path, which sees the queued batch as work.
  const round = runMetaAgentRoundNow({ scheduler, ownerUserId: OWNER });
  assert.equal(round.workspaces[0].outcome, 'started');
  await until(() => executor.started[1]?.hooks.maintenanceContext !== undefined);
  assert.equal(executor.started[1].hooks.maintenanceContext!.planId, planId, 'the held batch, not a new plan over the same turns');
  executor.started[1].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
});

function maintenanceScheduler(executor: Executor) {
  const scheduler = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: (runtimeId) => runtimeId === 'pi',
    clock: () => now, instanceId: 'attention-test-worker', createId: () => `job-${++nextId}`, pollIntervalMs: 60_000 });
  const job = scheduler.createJob({ workspaceId: 'ws', name: 'Space maintenance', prompt: 'Maintain relevant spaces',
    schedule: { kind: 'every', everySeconds: 60 }, permissionMode: 'trust', sessionMode: 'fresh', conversationUpdates: true, notify: false });
  createMaintenanceConfig({ workspaceId: 'ws', ownerUserId: OWNER, jobId: job.id, now, enabled: true });
  updateMetaAgentSettings({ runtimeId: 'pi' });
  getDb().prepare('UPDATE scheduled_jobs SET conversation_cursor=0 WHERE id=?').run(job.id);
  getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=0 WHERE job_id=?').run(job.id);
  return { scheduler, job };
}

const completionCursor = () => (getDb().prepare('SELECT completion_cursor FROM page_maintenance_configs').get() as { completion_cursor: number }).completion_cursor;

test('Retry completes a held batch whose conversation was deleted: the source is skipped and the cursor moves on', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  completeSource('turn-a');
  await scheduler.runNow(job.id);
  await until(() => executor.started[0]?.hooks.maintenanceContext !== undefined);
  const planId = executor.started[0].hooks.maintenanceContext!.planId;
  markMaintenanceSourceAttention({ planId, ownerUserId: OWNER, sourceTurnId: 'turn-a', reason: 'A frozen source message is no longer readable', now });
  executor.started[0].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  getDb().prepare('UPDATE nodes SET deleted_at=? WHERE id=?').run(now, 'source-node-turn-a');

  now += 60_000;
  setMetaAgentPaused({ scheduler, ownerUserId: OWNER, paused: false, clock: () => now });
  assert.equal(runMetaAgentRoundNow({ scheduler, ownerUserId: OWNER }).workspaces[0].outcome, 'started');
  await until(() => scheduler.getJob(job.id).activeRunId === null);

  assert.equal(executor.started.length, 1, 'no session opens for a batch with nothing left to read');
  const plan = getMaintenancePlan(planId, OWNER)!;
  assert.equal(plan.state, 'terminal');
  assert.deepEqual(plan.sources.map((source) => [source.state, source.terminalReason]), [['skipped', 'Skipped: the conversation was deleted']]);
  assert.equal(completionCursor(), plan.through);
  assert.ok(plan.through > 0);
  assert.equal(scheduler.getJob(job.id).lastStatus, 'succeeded');
  assert.equal(listMaintenanceBacklog('ws', OWNER).plans.length, 0);
});

test('a pending batch reads only what is left: purged and archived sources are skipped, a live one is kept', async () => {
  const executor = new Executor();
  const { scheduler, job } = maintenanceScheduler(executor);
  for (const turnId of ['turn-a', 'turn-b', 'turn-c']) completeSource(turnId);
  await scheduler.runNow(job.id);
  await until(() => executor.started[0]?.hooks.maintenanceContext !== undefined);
  const planId = executor.started[0].hooks.maintenanceContext!.planId;
  executor.started[0].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  assert.equal(getMaintenancePlan(planId, OWNER)!.state, 'routing', 'the run left every source undecided');
  getDb().prepare('DELETE FROM messages WHERE node_id=?').run('source-node-turn-a');
  getDb().prepare('UPDATE nodes SET purged_at=? WHERE id=?').run(now, 'source-node-turn-a');
  getDb().prepare("UPDATE nodes SET status='archived' WHERE id=?").run('source-node-turn-b');

  now += 60_000;
  await scheduler.runNow(job.id);
  await until(() => executor.started[1]?.hooks.maintenanceContext !== undefined);
  const context = executor.started[1].hooks.maintenanceContext!;
  assert.equal(context.planId, planId);
  assert.deepEqual(context.sources.map((source) => source.sourceTurnId), ['turn-c']);
  assert.deepEqual(getMaintenancePlan(planId, OWNER)!.sources.map((source) => [source.sourceTurnId, source.state, source.terminalReason]), [
    ['turn-a', 'skipped', 'Skipped: the conversation was deleted'],
    ['turn-b', 'skipped', 'Skipped: the conversation was archived'],
    ['turn-c', 'routing', null],
  ]);
  executor.started[1].resolve();
  await until(() => scheduler.getJob(job.id).activeRunId === null);
  assert.equal(completionCursor(), 0, 'the live source still holds the cursor until it is decided');
});
