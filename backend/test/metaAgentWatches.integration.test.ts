import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type MaintenanceWorkspaceResponse, type PageWriteResult } from 'michi-shared';
import type { AgentRuntime } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getMaintenanceConfig, setSpaceMaintenanceExcluded } from '../src/services/pages/maintenanceRepository';
import { PageMaintenanceConfigService } from '../src/services/pages/maintenanceConfig';
import { createMaintenanceTools } from '../src/services/pages/maintenanceTools';
import type { MaintenanceExecutionContext } from '../src/services/pages/maintenanceWriter';
import { createPage, getDatabase, getPage } from '../src/services/pages/repository';
import { openTaskDatabase } from '../src/services/pages/taskDatabase';
import { maintenanceHasWork } from '../src/services/metaAgent/maintenanceCoordinator';
import { createWatch, listWatches, saveWorkspaceInstructions, updateWatch } from '../src/services/metaAgent/watches';
import { setupPageMaintenanceRoutes } from '../src/routes/pageMaintenance';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import {
  ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunHandle, type ScheduledRunHooks, type ScheduledRunOutcome,
} from '../src/services/scheduledJobs/scheduler';

const OWNER = 'local-user';
const MINUTE = 60_000;

function fakeRuntime(id: string): AgentRuntime {
  return {
    id, label: id,
    descriptor: UNKNOWN_RUNTIME_DESCRIPTOR,
    capabilities: {
      modes: false, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: false,
      saveContext: false, spawnBranches: false, nativeResume: false,
    },
    async warm() {}, async newSession() { throw new Error('not used'); }, async releaseSession() {}, async shutdown() {},
  };
}
registerRuntime(fakeRuntime('pi'));

let tmpDir: string;
let now: number;
let priorDataDir: string | undefined;
let priorCloud: string | undefined;
let jobSeq = 0;
let server: http.Server | null = null;

type ToolResult = { isError?: boolean; content: Array<{ text: string }>; details?: unknown };

interface ModelRun {
  job: ScheduledJobRecord;
  hooks: ScheduledRunHooks;
  planId: string;
  call<T = any>(name: string, args: Record<string, unknown>): T;
  refused(name: string, args: Record<string, unknown>): string;
}
type Script = (run: ModelRun) => { reply?: string } | void;

/** Stands in for the runtime: drives the maintenance tools with each run's server-bound context. */
class FakeModel implements ScheduledJobExecutor {
  processExitStopsExecution = true;
  started: ModelRun[] = [];
  script: Script = () => {};

  async start(job: ScheduledJobRecord, run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    const index = this.started.length + 1;
    const nodeId = `maintenance-node-${index}`;
    const turnId = `maintenance-turn-${index}`;
    const assistantId = `maintenance-assistant-${index}`;
    getDb().prepare(`INSERT INTO nodes(id,workspace_id,kind,status,minimized,created_at,maintenance_job_id) VALUES(?,?,'chat','idle',0,?,?)`)
      .run(nodeId, job.workspaceId, now, job.id);
    let turn = createDurableTurn({ turnId, assistantId, nodeId, workspaceId: job.workspaceId, displayUserText: job.prompt,
      userMetadata: { scheduledJobId: job.id }, selfInitiated: true, keepUserMessage: true, startedAt: now });
    beginTurn(turn);
    const context = { ...hooks.maintenanceContext!, execution: { nodeId, turnId, assistantId, runId: run.id } } as MaintenanceExecutionContext;
    const attempt = (name: string, args: Record<string, unknown>) =>
      createMaintenanceTools(context, { now: () => now }).find((tool) => tool.name === name)!.execute(args) as ToolResult;
    const modelRun: ModelRun = { job, hooks, planId: hooks.maintenanceContext?.planId ?? '',
      call: (name, args) => { const result = attempt(name, args); assert.notEqual(result.isError, true, result.content[0]?.text); return result.details as any; },
      refused: (name, args) => { const result = attempt(name, args); assert.equal(result.isError, true, `${name} should be refused`); return result.content[0]!.text; } };
    this.started.push(modelRun);
    const work = (async (): Promise<ScheduledRunOutcome> => {
      await flush();
      const result = this.script(modelRun) ?? {};
      turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: result.reply ?? 'Done.' } } as ChatStreamEvent);
      finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
      return { status: 'succeeded', summary: 'done', error: null };
    })();
    return { nodeId, treeId: null, turnId, done: work, cancel: () => {} };
  }
}

function flush(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(`${label} did not become true`);
}

function scheduler(model: FakeModel): ScheduledJobScheduler {
  const created = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor: model,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: (id) => id === 'pi',
    clock: () => now, instanceId: 'watch-test', createId: () => `job-${++jobSeq}`, pollIntervalMs: 600_000, maxConcurrentRuns: 1, cancelGraceMs: 5 });
  created.start();
  return created;
}

function enable(sched: ScheduledJobScheduler): string {
  return new PageMaintenanceConfigService(sched, () => now).enable({ workspaceId: 'ws', ownerUserId: OWNER, enabled: true }).config.jobId;
}

/** Starts one maintenance run and waits until the scheduler has settled it. */
async function runOnce(sched: ScheduledJobScheduler, model: FakeModel, jobId: string): Promise<ModelRun> {
  const before = model.started.length;
  const started = sched.startNow(jobId);
  assert.ok('run' in started, `expected a run, got ${JSON.stringify(started)}`);
  await until(() => model.started.length > before && sched.getJob(jobId).activeRunId === null, 'the run to settle');
  return model.started.at(-1)!;
}

function completeConversation(turnId: string): void {
  const nodeId = `source-${turnId}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?, 'ws', 'chat', 'idle', ?)").run(nodeId, now);
  let turn = createDurableTurn({ turnId, assistantId: `assistant-${turnId}`, nodeId, workspaceId: 'ws', displayUserText: 'Plan the launch', startedAt: now });
  beginTurn(turn);
  turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: 'Launch is planned.' } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
}

beforeEach(() => {
  priorDataDir = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-meta-watches-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  now = Date.parse('2026-10-31T09:00:00Z');
  mock.method(Date, 'now', () => now);
  jobSeq = 0;
  getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)').run('ws', 'On-call', now, now);
  updateMetaAgentSettings({ runtimeId: 'pi' });
});

afterEach(async () => {
  if (server) {
    const open = server;
    server = null;
    await new Promise<void>((resolve) => { open.close(() => resolve()); open.closeAllConnections(); });
  }
  mock.restoreAll();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
});

test('a due watch runs as its own check: one final decision per resource, and the conversation cursor stays put', async () => {
  const page = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Tickets', now });
  const tasks = openTaskDatabase({ workspaceId: 'ws', ownerUserId: OWNER, now }).database;
  const model = new FakeModel();
  const sched = scheduler(model);
  try {
    const jobId = enable(sched);
    const cursor = getMaintenanceConfig('ws', OWNER)!.completionCursor;
    saveWorkspaceInstructions({ workspaceId: 'ws', ownerUserId: OWNER, text: 'Owners are listed on the Tickets page.', expectedRevision: 0, now });
    createWatch({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Sev-2 tickets', instructions: 'Check open Sev-2 tickets in resolver group X',
      intervalMinutes: 30, now });
    const startedAt = now;
    let added: PageWriteResult | null = null;
    model.script = (run) => {
      assert.match(run.job.prompt, /Watch "Sev-2 tickets" for the workspace "On-call"\. Michi runs this check every 30 minutes/);
      assert.match(run.job.prompt, /Check open Sev-2 tickets in resolver group X/);
      assert.match(run.job.prompt, /The user's instructions for this workspace[^\n]*\nOwners are listed on the Tickets page\./);
      assert.ok(run.planId.startsWith('mwr-'));
      assert.deepEqual(run.hooks.maintenanceContext?.sources, []);
      assert.equal(run.hooks.conversationBatch, undefined);
      const id = run.planId;
      assert.equal(run.call('maintenance_read_source', { sourceTurnId: id }).previous, null);
      const listed = run.call('maintenance_list_resources', { sourceTurnId: id });
      assert.ok(listed.resources.some((entry: { kind: string; id: string }) => entry.kind === 'page' && entry.id === page.id));
      assert.ok(listed.resources.some((entry: { id: string; role?: string }) => entry.id === tasks.id && entry.role === 'tasks'));
      assert.match(run.refused('maintenance_route_source', { sourceTurnId: id, candidates: [] }), /does not route/);
      assert.match(run.refused('read_node', { nodeId: 'n' }), /not used in a watch check/);
      assert.match(run.refused('maintenance_list_tasks', { sourceTurnId: 'turn-x' }), /Use sourceTurnId/);
      const row = [{ op: 'row.add', values: { task: 'T-1: login errors', status: 'todo', next: 'Triage with the owner' } }];
      assert.match(run.refused('maintenance_write_database', { sourceTurnId: id, databaseId: tasks.id, ops: row }), /Read this database/);
      assert.deepEqual(run.call('maintenance_list_tasks', { sourceTurnId: id }).tasks, []);
      added = run.call<PageWriteResult>('maintenance_write_database', { sourceTurnId: id, databaseId: tasks.id, ops: row });
      assert.equal(added.applied.length, 1);
      // An exact retry replays the decision; anything else is refused once it is final.
      assert.deepEqual(run.call('maintenance_write_database', { sourceTurnId: id, databaseId: tasks.id, ops: row }), added);
      assert.match(run.refused('maintenance_write_database', { sourceTurnId: id, databaseId: tasks.id,
        ops: [{ op: 'row.add', values: { task: 'T-2' } }] }), /final decision/);
      const read = run.call('maintenance_read_page', { sourceTurnId: id, pageId: page.id });
      assert.ok('layoutRules' in read);
      run.call('maintenance_write_page', { sourceTurnId: id, pageId: page.id,
        ops: [{ op: 'insert', block: { type: 'callout', text: 'T-1 is open: login errors', tone: 'warn' }, after: null }] });
      assert.match(run.refused('maintenance_no_change', { sourceTurnId: id, resourceKind: 'page', resourceId: page.id, reason: 'x' }), /final decision/);
      return { reply: 'Updated the board.\n\nObserved:\n- T-1 open (login errors)' };
    };
    await runOnce(sched, model, jobId);

    const job = sched.getJob(jobId);
    assert.equal(job.lastStatus, 'succeeded', job.lastError ?? undefined);
    assert.equal(sched.listRuns(jobId)[0]!.summary, 'Watch “Sev-2 tickets”: updated 2');
    assert.equal(getMaintenanceConfig('ws', OWNER)!.completionCursor, cursor);
    assert.equal(getDatabase(tasks.id, OWNER).rows.length, 1);
    assert.equal(getPage(page.id, OWNER).blocks[0]!.type, 'callout');
    const [watch] = listWatches('ws', OWNER);
    assert.equal(watch!.lastRun?.state, 'succeeded');
    assert.equal(watch!.nextCheckAt, startedAt + 30 * MINUTE);

    // Not due again until its interval has passed since the check started.
    now += 29 * MINUTE;
    assert.equal(maintenanceHasWork('ws', OWNER, now), false);
    now += MINUTE;
    assert.equal(maintenanceHasWork('ws', OWNER, now), true);
    model.script = (run) => {
      assert.match(run.call('maintenance_read_source', { sourceTurnId: run.planId }).previous.report, /Observed:\n- T-1 open/);
      run.call('maintenance_no_change', { sourceTurnId: run.planId, resourceKind: 'database', resourceId: tasks.id, reason: 'T-1 is unchanged' });
    };
    await runOnce(sched, model, jobId);
    assert.equal(sched.listRuns(jobId)[0]!.summary, 'Watch “Sev-2 tickets”: no change to 1');
    assert.ok(added);
  } finally {
    await sched.stop();
  }
});

test('a check that records no decision fails, and three in a row pause the watch until it is turned back on', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  try {
    const jobId = enable(sched);
    const watchId = createWatch({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Tasks', instructions: 'Sync my project tasks', intervalMinutes: 15, now });
    model.script = () => ({ reply: 'Everything looks fine.' });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runOnce(sched, model, jobId);
      assert.equal(sched.listRuns(jobId)[0]!.status, 'failed');
      assert.match(sched.listRuns(jobId)[0]!.error ?? '', /finished watch “Tasks” without recording a decision/);
      now += 15 * MINUTE;
    }
    const [paused] = listWatches('ws', OWNER);
    assert.equal(paused!.enabled, false);
    assert.match(paused!.pausedReason ?? '', /^Paused after 3 failed checks in a row/);
    assert.equal(maintenanceHasWork('ws', OWNER, now), false);
    updateWatch({ workspaceId: 'ws', ownerUserId: OWNER, watchId, expectedRevision: paused!.revision, enabled: true, now });
    const [resumed] = listWatches('ws', OWNER);
    assert.equal(resumed!.pausedReason, null);
    assert.equal(maintenanceHasWork('ws', OWNER, now), true);
  } finally {
    await sched.stop();
  }
});

test('a due watch goes before conversation work, which then carries the workspace instructions; excluded pages stay out of reach', async () => {
  const excluded = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Private notes', now });
  const model = new FakeModel();
  const sched = scheduler(model);
  try {
    const jobId = enable(sched);
    setSpaceMaintenanceExcluded({ workspaceId: 'ws', ownerUserId: OWNER, spaceId: excluded.id, excluded: true,
      expectedRevision: getMaintenanceConfig('ws', OWNER)!.revision, now });
    saveWorkspaceInstructions({ workspaceId: 'ws', ownerUserId: OWNER, text: 'Keep summaries in English.', expectedRevision: 0, now });
    createWatch({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Tickets', instructions: 'Check tickets', intervalMinutes: 60, now });
    completeConversation('turn-a');
    model.script = (run) => {
      assert.match(run.refused('maintenance_read_page', { sourceTurnId: run.planId, pageId: excluded.id }), /not one this watch may change/);
      run.call('maintenance_no_change', { sourceTurnId: run.planId, resourceKind: 'page', resourceId: createPage({ workspaceId: 'ws',
        ownerUserId: OWNER, title: 'Board', now }).id, reason: 'No tickets' });
    };
    const watchRun = await runOnce(sched, model, jobId);
    assert.ok(watchRun.planId.startsWith('mwr-'));
    model.script = () => {};
    const conversationRun = await runOnce(sched, model, jobId);
    assert.deepEqual(conversationRun.hooks.conversationBatch?.turns.map((turn) => turn.turnId), ['turn-a']);
    assert.match(conversationRun.job.prompt, /Keep summaries in English\./);
  } finally {
    await sched.stop();
  }
});

test('the maintenance routes save instructions and add, change, run and delete watches', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  try {
    const app = express();
    app.use(express.json());
    app.use('/api', setupPageMaintenanceRoutes({ scheduler: sched, clock: () => now }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/workspaces/ws/maintenance`;
    const send = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as MaintenanceWorkspaceResponse & { error?: { message: string } } };
    };

    const early = await send('POST', `${base}/watches`, { title: 'Tickets', instructions: 'Check tickets', intervalMinutes: 30 });
    assert.equal(early.status, 409);
    assert.match(early.body.error!.message, /Enable updates/);
    const jobId = enable(sched);

    const saved = await send('PUT', `${base}/instructions`, { expectedRevision: 0, text: '  Track Sev-2 only.  ' });
    assert.equal(saved.status, 200);
    assert.deepEqual({ text: saved.body.instructions?.text, revision: saved.body.instructions?.revision }, { text: 'Track Sev-2 only.', revision: 1 });
    assert.equal((await send('PUT', `${base}/instructions`, { expectedRevision: 0, text: 'x' })).status, 409);

    assert.equal((await send('POST', `${base}/watches`, { title: 'Tickets', instructions: 'Check tickets', intervalMinutes: 5 })).status, 400);
    const created = await send('POST', `${base}/watches`, { title: 'Tickets', instructions: 'Check tickets', intervalMinutes: 30, enabled: false });
    assert.equal(created.status, 201);
    const watch = created.body.watches![0]!;
    assert.deepEqual({ title: watch.title, intervalMinutes: watch.intervalMinutes, enabled: watch.enabled, nextCheckAt: watch.nextCheckAt },
      { title: 'Tickets', intervalMinutes: 30, enabled: false, nextCheckAt: null });
    assert.equal((await send('POST', `${base}/watches/${watch.id}/run`, {})).status, 409);

    const board = createPage({ workspaceId: 'ws', ownerUserId: OWNER, title: 'Board', now });
    model.script = (run) => { run.call('maintenance_no_change', { sourceTurnId: run.planId, resourceKind: 'page', resourceId: board.id, reason: 'Nothing open' }); };
    // Turning a new watch on makes it due at once: the change wakes the maintenance execution.
    const changed = await send('PATCH', `${base}/watches/${watch.id}`, { expectedRevision: watch.revision, enabled: true, intervalMinutes: 60 });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.watches![0]!.intervalMinutes, 60);
    assert.equal((await send('PATCH', `${base}/watches/${watch.id}`, { expectedRevision: watch.revision, title: 'Stale' })).status, 409);
    await until(() => model.started.length === 1 && sched.getJob(jobId).activeRunId === null, 'the first check');

    // Run now makes it due again before its interval has passed.
    assert.equal(maintenanceHasWork('ws', OWNER, now), false);
    const ran = await send('POST', `${base}/watches/${watch.id}/run`, {});
    assert.equal(ran.status, 202);
    await until(() => model.started.length === 2 && sched.getJob(jobId).activeRunId === null, 'the requested check');
    const after = (await send('GET', base)).body.watches![0]!;
    assert.deepEqual({ state: after.lastRun?.state, runRequested: after.runRequested }, { state: 'succeeded', runRequested: false });

    const removed = await send('DELETE', `${base}/watches/${watch.id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.watches, []);
  } finally {
    await sched.stop();
  }
});
