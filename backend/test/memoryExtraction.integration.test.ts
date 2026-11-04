// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type MemoryRecord } from 'michi-shared';
import type { AgentRuntime, MaintenanceExecutionContext } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { pauseMaintenanceCoordinator } from '../src/services/metaAgent/maintenanceCoordinator';
import { metaAgentUsageToday, startOfLocalDay } from '../src/services/metaAgent/todayUsage';
import { beginTurn, deleteWorkspace, finalizeTurn } from '../src/services/dbRepository';
import { closeDb, getDb, initDb } from '../src/services/db';
import { recordUntrustedSource } from '../src/services/turnTrust';
import {
  approveMemory, createMemory, deleteMemory, listMemories, rejectMemory, setMemorySettings,
} from '../src/services/memory/memoryService';
import { purgeOwnerMemories } from '../src/services/memory/memoryRepository';
import { createMemoryExtractionTools, type ExtractionToolResult } from '../src/services/memory/extractionTools';
import { addExtractionUsage, getExtractionCursor } from '../src/services/memory/extractionRepository';
import { MEMORY_EXTRACTION_LIMITS, memoryExtractionHasWork } from '../src/services/memory/extractionRun';
import {
  attachMemoryExtractionScheduler, cancelMemoryExtraction, installMemoryExtractionHooks, memoryExtractionStatus, setMemoryExtractionPaused,
} from '../src/services/memory/extractionService';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import {
  ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunHandle, type ScheduledRunHooks, type ScheduledRunOutcome,
} from '../src/services/scheduledJobs/scheduler';
import { loadExtractionFixtures, type ExtractionFixtureCase, type ExtractionFixtureTurn } from './helpers/memoryExtractionFixtures';

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
let modelSessions = 0;
let uninstallHooks: (() => void) | null = null;
const schedulers: ScheduledJobScheduler[] = [];

interface IndexEntry { sourceTurnId: string; completedAt: string; correctionHint?: string; readUntrustedContent?: boolean }

interface ModelRun {
  job: ScheduledJobRecord;
  hooks: ScheduledRunHooks;
  index: IndexEntry[];
  attempt(name: string, args: unknown): ExtractionToolResult;
  /** A call that must succeed; returns its result. */
  call<T = any>(name: string, args: unknown): T;
  cancelled: Promise<void>;
}
type ScriptResult = { usage?: number; reply?: string } | void;
type Script = (run: ModelRun) => ScriptResult | Promise<ScriptResult>;

/** Every source turn: read it, then record no change. */
const readAndSkip: Script = (run) => {
  for (const source of run.index) {
    run.call('memory_read_source', { sourceTurnId: source.sourceTurnId });
    run.call('memory_no_change', { sourceTurnId: source.sourceTurnId, reason: 'nothing durable' });
  }
};

/** Stands in for the Meta agent runtime: drives the closed extraction tools with each run's server-bound context. */
class FakeModel implements ScheduledJobExecutor {
  processExitStopsExecution = true;
  started: ModelRun[] = [];
  errors: unknown[] = [];
  script: Script = readAndSkip;

  async start(job: ScheduledJobRecord, run: ScheduledJobRunRecord, hooks: ScheduledRunHooks): Promise<ScheduledRunHandle> {
    const index = ++modelSessions;
    const nodeId = `extract-node-${index}`;
    const turnId = `extract-turn-${index}`;
    const assistantId = `extract-answer-${index}`;
    getDb().prepare(`INSERT INTO nodes(id,workspace_id,kind,status,minimized,created_at,maintenance_job_id) VALUES(?,?,'chat','idle',0,?,?)`)
      .run(nodeId, job.workspaceId, now, job.id);
    let turn = createDurableTurn({ turnId, assistantId, nodeId, workspaceId: job.workspaceId, displayUserText: job.prompt,
      userMetadata: { scheduledJobId: job.id }, selfInitiated: true, keepUserMessage: true, startedAt: now });
    beginTurn(turn);
    const context = { ...hooks.maintenanceContext!, execution: { nodeId, turnId, assistantId, runId: run.id } } as MaintenanceExecutionContext;
    const tools = createMemoryExtractionTools(context, { now: () => now });
    let cancel!: () => void;
    let wasCancelled = false;
    const cancelled = new Promise<void>((resolve) => { cancel = () => { wasCancelled = true; resolve(); }; });
    const attempt = (name: string, args: unknown) => tools.find((tool) => tool.name === name)!.execute(args);
    const modelRun: ModelRun = {
      job, hooks, index: JSON.parse(job.prompt.split('\n').at(-1)!) as IndexEntry[], attempt, cancelled,
      call: (name, args) => { const result = attempt(name, args); assert.notEqual(result.isError, true, result.content[0]?.text); return result.details as any; },
    };
    this.started.push(modelRun);
    const work = (async (): Promise<ScheduledRunOutcome> => {
      await flush();
      let result: ScriptResult = undefined;
      try { result = await this.script(modelRun); } catch (error) { this.errors.push(error); }
      if (result?.usage !== undefined) {
        turn = applyTurnEvent(turn, { event: 'usage_summary', data: { seq: 1, totalTokens: result.usage } } as unknown as ChatStreamEvent);
      }
      turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 2, text: result?.reply ?? 'Done.' } } as ChatStreamEvent);
      finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 3, stopReason: wasCancelled ? 'cancelled' : 'end_turn' } } as ChatStreamEvent));
      return { status: wasCancelled ? 'cancelled' : 'succeeded', summary: 'done', error: null };
    })();
    return { nodeId, treeId: null, turnId, done: work, cancel };
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
    clock: () => now, instanceId: 'memory-test', createId: () => `job-${++jobSeq}`, pollIntervalMs: 600_000, maxConcurrentRuns: 2, cancelGraceMs: 5 });
  created.start();
  schedulers.push(created);
  return created;
}

function addWorkspace(id: string, createdAt = now): void {
  getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id, `Workspace ${id}`, createdAt, createdAt);
}

/** Switches the owner to auto mode and lets the scheduler create the execution identities. */
async function enableAuto(sched: ScheduledJobScheduler, workspaceId = 'ws'): Promise<string> {
  await sched.tick(); // the tick start() began, before auto mode
  setMemorySettings(OWNER, { mode: 'auto' });
  await sched.tick();
  const jobId = getExtractionCursor(workspaceId, OWNER)?.jobId;
  assert.ok(jobId, 'the extraction consumer has an execution identity');
  return jobId;
}

/** One completed conversation turn; `untrusted` marks it as having read a web page. */
function completeTurn(input: { turnId: string; user: string; reply: string; workspaceId?: string; nodeId?: string; untrusted?: boolean }): string {
  const workspaceId = input.workspaceId ?? 'ws';
  const nodeId = input.nodeId ?? `source-${input.turnId}`;
  getDb().prepare("INSERT OR IGNORE INTO nodes(id,workspace_id,kind,status,created_at) VALUES(?, ?, 'chat', 'idle', ?)").run(nodeId, workspaceId, now);
  let turn = createDurableTurn({ turnId: input.turnId, assistantId: `assistant-${input.turnId}`, nodeId, workspaceId, displayUserText: input.user, startedAt: now });
  beginTurn(turn);
  if (input.untrusted) recordUntrustedSource({ nodeId, turnId: input.turnId }, { tool: 'fetch_content', runtimeId: 'pi', detail: 'https://example.com/page' });
  turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: input.reply } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
  return input.turnId;
}

/** Starts one extraction run and waits until the scheduler settled it. */
async function runOnce(sched: ScheduledJobScheduler, model: FakeModel, jobId: string): Promise<ModelRun> {
  now += 1_000; // run history is ordered by start time
  const before = model.started.length;
  const started = sched.startNow(jobId);
  assert.ok('run' in started, `expected a run, got ${JSON.stringify(started)}`);
  await until(() => sched.getJob(jobId).activeRunId === null, 'the run to settle');
  assert.deepEqual(model.errors, [], 'the scripted model\'s own assertions');
  assert.equal(model.started.length, before + 1, `the run opened one model session (${JSON.stringify(sched.listRuns(jobId)[0])})`);
  return model.started.at(-1)!;
}

function extracted(): MemoryRecord[] {
  return listMemories({ ownerUserId: OWNER }, { status: ['active', 'pending', 'superseded'], limit: 200 }).items.filter((memory) => memory.origin === 'extracted');
}

function lastRun(sched: ScheduledJobScheduler, jobId: string) { return sched.listRuns(jobId)[0]!; }

function refusal(started: ReturnType<ScheduledJobScheduler['startNow']>): string | null {
  return 'refused' in started ? started.refused : null;
}

function rowCount(table: string, where = '1=1', ...args: unknown[]): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...(args as never[])) as { n: number }).n;
}

beforeEach(() => {
  priorDataDir = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-memory-extraction-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  now = Date.parse('2026-11-03T09:00:00Z');
  mock.method(Date, 'now', () => now);
  jobSeq = 0;
  addWorkspace('ws', now - 10 * MINUTE);
  updateMetaAgentSettings({ runtimeId: 'pi' });
  uninstallHooks = installMemoryExtractionHooks();
});

afterEach(async () => {
  for (const sched of schedulers.splice(0)) await sched.stop();
  uninstallHooks?.();
  uninstallHooks = null;
  mock.restoreAll();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
});

// ── input and discovery ──────────────────────────────────────────────────────

test('enabling auto mode starts at the current completion position; a later workspace starts at 0; empty checks never call the model', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  completeTurn({ turnId: 'old-1', user: '这个仓库统一用 pnpm。', reply: '好的。' });
  completeTurn({ turnId: 'old-2', user: 'Use tabs.', reply: 'OK.' });
  // Explicit mode: no consumer, no execution identity.
  await sched.tick();
  assert.equal(getExtractionCursor('ws', OWNER), null);

  const jobId = await enableAuto(sched);
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 2, 'history before enabling is not backfilled');
  assert.equal(memoryExtractionHasWork({ jobId, workspaceId: 'ws', ownerUserId: OWNER }, now), false);
  for (let i = 0; i < 3; i += 1) { now += 61_000; await sched.tick(); await flush(); }
  assert.equal(model.started.length, 0, 'no new turn: no session and no model call');
  assert.equal(sched.listRuns(jobId).length, 0, 'no empty run records');
  assert.deepEqual(sched.listJobs(), [], 'the execution identity is not an ordinary scheduled job');

  // A workspace created after auto mode was enabled starts at 0: all its turns are new.
  now += 1_000;
  addWorkspace('ws-new', now);
  completeTurn({ turnId: 'new-ws-1', user: 'We deploy from the release branch.', reply: 'Noted.', workspaceId: 'ws-new' });
  await sched.tick();
  assert.equal(getExtractionCursor('ws-new', OWNER)!.completionCursor, 0);

  completeTurn({ turnId: 'fresh-1', user: '提交信息用英文写。', reply: '好的。' });
  now += 61_000;
  await sched.tick();
  await until(() => model.started.length === 1 && sched.getJob(jobId).activeRunId === null, 'the coordinator to run the new turn');
  assert.deepEqual(model.started[0]!.index.map((entry) => entry.sourceTurnId), ['fresh-1'], 'only the turn completed after enabling');
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 3);
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
  // The same coordinator check runs at most one maintenance execution; the other workspace's waits for the next check.
  now += 61_000;
  await sched.tick();
  await until(() => model.started.length === 2, 'the next workspace');
  assert.deepEqual(model.started[1]!.index.map((entry) => entry.sourceTurnId), ['new-ws-1']);
});

test('a run whose source turns became unreadable advances past them without a model', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 'gone-1', user: 'Remember: use pnpm.', reply: 'OK.' });
  getDb().prepare('UPDATE nodes SET deleted_at = ? WHERE id = ?').run(now, 'source-gone-1');
  const started = sched.startNow(jobId);
  assert.ok('run' in started);
  await until(() => sched.getJob(jobId).activeRunId === null, 'the run to settle');
  assert.equal(model.started.length, 0);
  assert.equal(lastRun(sched, jobId).summary, 'No new conversation turns');
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 1);
  assert.equal(refusal(sched.startNow(jobId)), 'no_work');
});

test('returning to auto mode never reads turns from while it was off', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  setMemorySettings(OWNER, { mode: 'explicit' });
  completeTurn({ turnId: 'while-off', user: 'Use 2-space indentation in this repo.', reply: 'OK.' });
  assert.equal(memoryExtractionHasWork({ jobId, workspaceId: 'ws', ownerUserId: OWNER }, now), false);
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 0);
  setMemorySettings(OWNER, { mode: 'auto' });
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 1, 're-enabling skips what happened while auto mode was off');
  assert.equal(memoryExtractionHasWork({ jobId, workspaceId: 'ws', ownerUserId: OWNER }, now), false);
  completeTurn({ turnId: 'after-return', user: 'Always answer in English.', reply: 'OK.' });
  const run = await runOnce(sched, model, jobId);
  assert.deepEqual(run.index.map((entry) => entry.sourceTurnId), ['after-return']);
});

test('pausing within auto mode keeps the cursor, so resuming catches up', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  setMemoryExtractionPaused({ ownerUserId: OWNER, paused: true, now, scheduler: sched });
  completeTurn({ turnId: 'while-paused', user: 'Use 2-space indentation in this repo.', reply: 'OK.' });
  assert.equal(memoryExtractionHasWork({ jobId, workspaceId: 'ws', ownerUserId: OWNER }, now), false);
  assert.equal(memoryExtractionStatus(OWNER, now, sched).state, 'paused');
  setMemoryExtractionPaused({ ownerUserId: OWNER, paused: false, now, scheduler: sched });
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 0);
  const run = await runOnce(sched, model, jobId);
  assert.deepEqual(run.index.map((entry) => entry.sourceTurnId), ['while-paused']);
});

// ── receipts and validation ──────────────────────────────────────────────────

test('proposals become pending extracted memories in the source workspace with a receipt per source turn', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-pref', user: '以后回复我都用中文吧。', reply: '好的。' });
  completeTurn({ turnId: 't-todo', user: '先把登录页的 bug 修了。', reply: '修好了。' });
  model.script = (run) => {
    assert.deepEqual(run.hooks.maintenanceContext?.sources, [], 'the batch is bound by run id, not the Pages routing index');
    assert.ok(run.hooks.maintenanceContext?.planId.startsWith('mxr-'));
    const read = run.call('memory_read_source', { sourceTurnId: 't-pref' });
    assert.equal(read.messages[0].role, 'user');
    assert.equal(read.messages[0].text, '以后回复我都用中文吧。');
    assert.deepEqual(run.call('memory_search', { query: '中文' }).memories, []);
    const proposed = run.call('memory_propose', { sourceTurnId: 't-pref', kind: 'preference', body: '回复用中文', scopeHint: 'maybe_global' });
    assert.equal(proposed.status, 'staged');
    // An exact retry replays its result; it is not a second candidate.
    assert.equal(run.call('memory_propose', { sourceTurnId: 't-pref', kind: 'preference', body: '回复用中文。 ', scopeHint: 'maybe_global' }).replayed, true);
    run.call('memory_read_source', { sourceTurnId: 't-todo' });
    run.call('memory_no_change', { sourceTurnId: 't-todo', reason: '临时任务，不是长期偏好' });
    assert.equal(extracted().length, 0, 'nothing is visible before the run settles');
    return { reply: 'Saved 1 memory.' };
  };
  await runOnce(sched, model, jobId);
  const run = lastRun(sched, jobId);
  assert.equal(run.status, 'succeeded', run.error ?? undefined);
  assert.match(run.summary ?? '', /read 2 turns · proposed 1 memory · nothing to save in 1 turn/);
  const [memory] = extracted();
  assert.equal(memory!.status, 'pending');
  assert.equal(memory!.origin, 'extracted');
  assert.deepEqual(memory!.scope, { kind: 'workspace', workspaceId: 'ws' }, 'extraction never writes the user scope');
  assert.equal(memory!.source?.turnId, 't-pref');
  assert.equal(memory!.sourceRisk, null);
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 2);
  const status = memoryExtractionStatus(OWNER, now, sched);
  assert.equal(status.pendingCount, 1);
  assert.deepEqual(status.maybeGlobalMemoryIds, [memory!.id]);
  assert.equal(status.recentRuns[0]!.proposed, 1);
  assert.equal(status.recentRuns[0]!.noChange, 1);
});

test('a reply that claims success without receipts fails and keeps the cursor', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  completeTurn({ turnId: 't-2', user: 'Commit messages follow Conventional Commits.', reply: 'OK.' });
  model.script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    run.call('memory_propose', { sourceTurnId: 't-1', kind: 'convention', body: 'This repo uses pnpm' });
    return { reply: 'All done, I saved everything.' };
  };
  await runOnce(sched, model, jobId);
  const run = lastRun(sched, jobId);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /without a receipt for 1 of 2 source turns/);
  assert.equal(extracted().length, 0, 'a partial run saves nothing');
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 0);
  assert.equal(sched.getJob(jobId).consecutiveFailures, 1);
  assert.match(memoryExtractionStatus(OWNER, now, sched).lastError ?? '', /without a receipt/);
});

test('invalid tool calls are repairable errors; two repairs are allowed and the third invalid call fails the run', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  model.script = (run) => {
    // Receipts need a read first.
    assert.match(run.attempt('memory_no_change', { sourceTurnId: 't-1', reason: 'x' }).content[0]!.text, /read source turn "t-1".*2 repairs left/);
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    assert.match(run.attempt('memory_propose', { sourceTurnId: 't-1', kind: 'opinion', body: 'pnpm' }).content[0]!.text, /Invalid memory_propose call.*1 repair left/);
    run.call('memory_propose', { sourceTurnId: 't-1', kind: 'convention', body: 'This repo uses pnpm' });
  };
  await runOnce(sched, model, jobId);
  assert.equal(lastRun(sched, jobId).status, 'succeeded', lastRun(sched, jobId).error ?? undefined);
  assert.equal(extracted().length, 1);

  completeTurn({ turnId: 't-2', user: 'We deploy from the release branch.', reply: 'OK.' });
  model.script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-2' });
    assert.match(run.attempt('memory_propose', { sourceTurnId: 't-2', kind: 'fact', body: '', extra: 1 }).content[0]!.text, /2 repairs left/);
    assert.match(run.attempt('memory_propose', { sourceTurnId: 'not-in-batch', kind: 'fact', body: 'release' }).content[0]!.text, /not in this batch.*1 repair left/);
    assert.match(run.attempt('memory_no_change', { sourceTurnId: 't-2' }).content[0]!.text, /run failed and nothing will be saved/);
    // Once failed, even valid calls are refused, and nothing is staged.
    assert.match(run.attempt('memory_no_change', { sourceTurnId: 't-2', reason: 'fine' }).content[0]!.text, /already failed after 3 invalid tool calls/);
    return { reply: 'Everything is saved.' };
  };
  await runOnce(sched, model, jobId);
  const failed = lastRun(sched, jobId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /3 invalid tool calls/);
  assert.equal(extracted().length, 1, 'the failed run saved nothing');
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 1);

  // A receipt kind is final per turn: proposals and no-change never mix.
  model.script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-2' });
    run.call('memory_no_change', { sourceTurnId: 't-2', reason: 'only a deploy detail' });
    assert.match(run.attempt('memory_propose', { sourceTurnId: 't-2', kind: 'fact', body: 'release branch' }).content[0]!.text, /already has a no-change receipt/);
    assert.equal(run.call('memory_no_change', { sourceTurnId: 't-2', reason: 'again' }).replayed, true);
  };
  await runOnce(sched, model, jobId);
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 2);
});

test('repeated failures stop the consumer; resume restarts it', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  model.script = () => ({ reply: 'Nothing to do.' });
  for (let i = 0; i < 5; i += 1) await runOnce(sched, model, jobId);
  assert.equal(sched.getJob(jobId).autoPaused, true);
  const status = memoryExtractionStatus(OWNER, now, sched);
  assert.equal(status.state, 'stopped');
  assert.match(status.stateReason ?? '', /Paused after 5 failed runs in a row/);
  // The coordinator skips a stopped consumer.
  now += 61_000; await sched.tick(); await flush();
  assert.equal(model.started.length, 5);
  setMemoryExtractionPaused({ ownerUserId: OWNER, paused: false, now, scheduler: sched });
  assert.equal(sched.getJob(jobId).autoPaused, false);
  model.script = readAndSkip;
  await runOnce(sched, model, jobId);
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
});

test('memory_search is read-only and scoped to the owner, this workspace and the user scope', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  addWorkspace('ws-other');
  const jobId = await enableAuto(sched);
  const mine = createMemory({ ownerUserId: OWNER }, { scope: { kind: 'user' }, kind: 'preference', body: '回复用中文', status: 'active', origin: 'explicit' });
  createMemory({ ownerUserId: OWNER }, { scope: { kind: 'workspace', workspaceId: 'ws-other' }, kind: 'convention', body: '回复用中文的格式', status: 'active', origin: 'explicit' });
  const theirs = createMemory({ ownerUserId: 'bob' }, { scope: { kind: 'user' }, kind: 'preference', body: '回复用中文和英文', status: 'active', origin: 'explicit' });
  completeTurn({ turnId: 't-1', user: '以后回复都用中文。', reply: '好的。' });
  model.script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    const found = run.call('memory_search', { query: '回复用中文' }).memories;
    assert.deepEqual(found.map((memory: { id: string }) => memory.id), [mine.id], 'neither another workspace nor another owner');
    assert.match(run.attempt('memory_propose', { sourceTurnId: 't-1', kind: 'preference', body: '回复都用中文', supersedesId: theirs.id }).content[0]!.text,
      /supersedesId must be/);
    run.call('memory_no_change', { sourceTurnId: 't-1', reason: `already stored as ${mine.id}` });
  };
  await runOnce(sched, model, jobId);
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
  assert.equal(extracted().length, 0);
});

test('tool calls bound to another owner or to a finished run are refused and are not counted as repairs', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  let context: MaintenanceExecutionContext | null = null;
  model.script = (run) => {
    context = { ...run.hooks.maintenanceContext!, execution: { nodeId: 'n', turnId: 't', assistantId: 'a', runId: run.hooks.maintenanceContext!.runId } };
    const asBob = createMemoryExtractionTools({ ...context, ownerUserId: 'bob' }, { now: () => now });
    assert.match(asBob[0]!.execute({ sourceTurnId: 't-1' }).content[0]!.text, /no longer owns the tool call/);
    const otherWorkspace = createMemoryExtractionTools({ ...context, workspaceId: 'ws-x' }, { now: () => now });
    assert.match(otherWorkspace[0]!.execute({ sourceTurnId: 't-1' }).content[0]!.text, /no longer owns the tool call/);
    readAndSkip(run);
  };
  await runOnce(sched, model, jobId);
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
  const row = getDb().prepare('SELECT invalid_calls, memory_version FROM memory_extraction_runs').get() as { invalid_calls: number; memory_version: number };
  assert.equal(row.invalid_calls, 0);
  assert.equal(typeof row.memory_version, 'number', 'the memory version is recorded when the run starts');
  const late = createMemoryExtractionTools(context!, { now: () => now });
  assert.match(late[3]!.execute({ sourceTurnId: 't-1', reason: 'late' }).content[0]!.text, /stopped or lost its scheduler ownership/);
});

test('a candidate whose source turn read untrusted content is pending with sourceRisk untrusted', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-web', user: '网页说用 Node 18，我们这边规定 Node 版本锁在 22.x。', reply: '明白。', untrusted: true });
  model.script = (run) => {
    assert.equal(run.index[0]!.readUntrustedContent, true);
    const read = run.call('memory_read_source', { sourceTurnId: 't-web' });
    assert.equal(read.readUntrustedContent, true);
    run.call('memory_propose', { sourceTurnId: 't-web', kind: 'convention', body: 'Node 版本锁在 22.x' });
  };
  await runOnce(sched, model, jobId);
  const [memory] = extracted();
  assert.equal(memory!.status, 'pending');
  assert.equal(memory!.sourceRisk, 'untrusted');
});

// ── pause, cancel and budgets ────────────────────────────────────────────────

test('pause blocks new runs at once and lets a running batch finish; cancel stops one and saves nothing', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  model.script = async (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    run.call('memory_propose', { sourceTurnId: 't-1', kind: 'convention', body: 'This repo uses pnpm' });
    await gate;
  };
  assert.ok('run' in sched.startNow(jobId));
  await until(() => model.started.length === 1, 'the run to start');
  setMemoryExtractionPaused({ ownerUserId: OWNER, paused: true, now, scheduler: sched });
  assert.equal(memoryExtractionStatus(OWNER, now, sched).paused, true);
  release();
  await until(() => sched.getJob(jobId).activeRunId === null, 'the paused run to finish its batch');
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
  assert.equal(extracted().length, 1, 'the batch that was running when paused still commits');
  completeTurn({ turnId: 't-2', user: 'We deploy from release.', reply: 'OK.' });
  assert.equal(refusal(sched.startNow(jobId)), 'no_work');
  now += 61_000; await sched.tick(); await flush();
  assert.equal(model.started.length, 1, 'paused: no new execution');

  setMemoryExtractionPaused({ ownerUserId: OWNER, paused: false, now, scheduler: sched });
  model.script = async (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-2' });
    run.call('memory_propose', { sourceTurnId: 't-2', kind: 'fact', body: 'We deploy from the release branch' });
    await run.cancelled;
  };
  assert.ok('run' in sched.startNow(jobId));
  await until(() => model.started.length === 2, 'the second run to start');
  assert.equal(cancelMemoryExtraction(OWNER, sched), 1);
  await until(() => sched.getJob(jobId).activeRunId === null, 'the cancelled run to settle');
  assert.equal(lastRun(sched, jobId).status, 'cancelled');
  assert.equal(extracted().length, 1, 'a cancelled run saves nothing');
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 1);
  const status = memoryExtractionStatus(OWNER, now, sched);
  assert.equal(status.recentRuns[0]!.state, 'cancelled');
  assert.equal(status.lastError, 'Cancelled');
});

test('leaving auto mode cancels a running extraction', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const detach = attachMemoryExtractionScheduler(sched);
  try {
    const jobId = await enableAuto(sched);
    completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
    model.script = async (run) => {
      run.call('memory_read_source', { sourceTurnId: 't-1' });
      setMemorySettings(OWNER, { mode: 'explicit' });
      assert.match(run.attempt('memory_no_change', { sourceTurnId: 't-1', reason: 'x' }).content[0]!.text, /turned off/);
      await run.cancelled;
    };
    assert.ok('run' in sched.startNow(jobId));
    await until(() => model.started.length === 1 && sched.getJob(jobId).activeRunId === null, 'the run to be cancelled');
    assert.deepEqual(model.errors, []);
    assert.equal(lastRun(sched, jobId).status, 'cancelled');
    assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 0);
  } finally { detach(); }
});

test('the Meta agent global maintenance pause also holds extraction', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  pauseMaintenanceCoordinator(OWNER, true);
  assert.equal(refusal(sched.startNow(jobId)), 'paused');
  assert.equal(memoryExtractionStatus(OWNER, now, sched).state, 'maintenance_paused');
  pauseMaintenanceCoordinator(OWNER, false);
  assert.equal(memoryExtractionStatus(OWNER, now, sched).state, 'waiting');
});

test('the daily token limit holds extraction without a model call and is visible', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  addExtractionUsage(OWNER, startOfLocalDay(now), MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - 1_000);
  assert.equal(memoryExtractionHasWork({ jobId, workspaceId: 'ws', ownerUserId: OWNER }, now), false);
  now += 61_000; await sched.tick(); await flush();
  assert.equal(model.started.length, 0);
  const status = memoryExtractionStatus(OWNER, now, sched);
  assert.equal(status.state, 'budget_exhausted');
  assert.match(status.stateReason ?? '', /limit of 1000000 tokens is reached/);
  assert.equal(status.todayTokens, MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - 1_000);
  assert.ok((getDb().prepare('SELECT exhausted_at FROM memory_extraction_usage').get() as { exhausted_at: number | null }).exhausted_at);
  // The next local day starts a new budget.
  now += 24 * 60 * MINUTE;
  assert.equal(memoryExtractionHasWork({ jobId, workspaceId: 'ws', ownerUserId: OWNER }, now), true);
});

test('the per-execution budget bounds the batch and the tools, and usage is charged', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  const details = 'The install, lockfile and CI steps all follow from it. '.repeat(50);
  for (const id of ['t-1', 't-2', 't-3']) completeTurn({ turnId: id, user: `Statement ${id}: this repo uses pnpm. ${details}`, reply: 'OK.' });
  // About 21,000 tokens left today: a budget for one source turn.
  const dayStart = startOfLocalDay(now);
  addExtractionUsage(OWNER, dayStart, MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - MEMORY_EXTRACTION_LIMITS.minExecutionBudget - 1_000);
  let refusedAfter = 0;
  model.script = (run) => {
    assert.deepEqual(run.index.map((entry) => entry.sourceTurnId), ['t-1'], 'the batch fits the budget');
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    for (let i = 0; i < 50; i += 1) {
      const result = run.attempt('memory_search', { query: 'pnpm' });
      if (result.isError) { assert.match(result.content[0]!.text, /reached its token budget/); refusedAfter = i; break; }
    }
    assert.ok(refusedAfter > 0, 'searches are refused once the estimate passes the budget');
    // A turn already read can still get its receipt.
    run.call('memory_no_change', { sourceTurnId: 't-1', reason: 'already stored' });
  };
  await runOnce(sched, model, jobId);
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 1, 'the cursor moved past the processed turn only');
  const usage = getDb().prepare('SELECT tokens FROM memory_extraction_usage WHERE owner_user_id=? AND day_start=?').get(OWNER, dayStart) as { tokens: number };
  assert.ok(usage.tokens >= MEMORY_EXTRACTION_LIMITS.dailyTokenLimit - MEMORY_EXTRACTION_LIMITS.minExecutionBudget, 'the estimate was charged');
  assert.equal(memoryExtractionStatus(OWNER, now, sched).state, 'budget_exhausted');
});

test('reported tokens are charged to the daily budget and appear in Meta agent usage', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  model.script = (run) => { readAndSkip(run); return { usage: 4_321 }; };
  await runOnce(sched, model, jobId);
  const status = memoryExtractionStatus(OWNER, now, sched);
  assert.equal(status.todayTokens, 4_321);
  assert.equal(status.recentRuns[0]!.tokens, 4_321);
  assert.equal(metaAgentUsageToday(OWNER, now).tokens, 4_321);
});

// ── tombstones ───────────────────────────────────────────────────────────────

test('a deleted proposal is never proposed again: after restart, recovery and catch-up of the same turn', async () => {
  let model = new FakeModel();
  let sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: '这个仓库统一用 pnpm，lockfile 只提交 pnpm-lock.yaml。', reply: '明白。' });
  const proposeBoth: Script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    return [run.call('memory_propose', { sourceTurnId: 't-1', kind: 'convention', body: '本仓库用 pnpm' }),
      run.call('memory_propose', { sourceTurnId: 't-1', kind: 'convention', body: 'lockfile 只提交 pnpm-lock.yaml' })] as unknown as ScriptResult;
  };
  model.script = proposeBoth;
  await runOnce(sched, model, jobId);
  const [first, second] = extracted().sort((a, b) => a.body.localeCompare(b.body));
  assert.ok(first && second);
  deleteMemory({ ownerUserId: OWNER }, first.id);
  rejectMemory({ ownerUserId: OWNER }, second.id);
  const tombstones = getDb().prepare('SELECT * FROM memory_extraction_tombstones ORDER BY seq').all() as Array<Record<string, unknown>>;
  assert.equal(tombstones.length, 2);
  assert.deepEqual(tombstones.map((row) => row.reason), ['deleted', 'rejected']);
  assert.ok(tombstones.every((row) => row.source_turn_id === 't-1' && /^[0-9a-f]{64}$/.test(String(row.body_hash))));
  assert.ok(!JSON.stringify(tombstones).includes('pnpm'), 'tombstones keep no body text');

  // Restart the backend, then recover/catch up the same turn (the cursor moves back over it).
  await sched.stop();
  schedulers.splice(0);
  closeDb();
  initDb();
  model = new FakeModel();
  sched = scheduler(model);
  await sched.tick();
  getDb().prepare('UPDATE memory_extraction_cursors SET completion_cursor = 0').run();
  let results: Array<{ status: string; reason?: string }> = [];
  model.script = (run) => { results = proposeBoth(run) as unknown as typeof results; };
  await runOnce(sched, model, jobId);
  assert.deepEqual(results.map((result) => result.status), ['dropped', 'dropped']);
  assert.match(results[0]!.reason ?? '', /removed this memory before/);
  assert.equal(lastRun(sched, jobId).status, 'succeeded', 'a dropped proposal is still the turn\'s receipt');
  assert.equal(extracted().length, 0);
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, 1);
});

test('a delete during a run drops its candidate at commit; a later turn restating the preference is proposed again', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: '本仓库用 pnpm。', reply: '好的。' });
  completeTurn({ turnId: 't-2', user: '回复别加 emoji。', reply: '好的。' });
  // A memory the chat saved explicitly from t-1.
  const saved = createMemory({ ownerUserId: OWNER }, { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'convention',
    body: '仓库的包管理器是 pnpm', status: 'active', origin: 'explicit', source: { turnId: 't-1' } });
  const earlier = createMemory({ ownerUserId: OWNER }, { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'preference',
    body: '回复里不加 emoji', status: 'pending', origin: 'extracted', source: { turnId: 'older-turn' } });
  model.script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    assert.equal(run.call('memory_propose', { sourceTurnId: 't-1', kind: 'convention', body: '依赖用 pnpm 安装' }).status, 'staged');
    run.call('memory_read_source', { sourceTurnId: 't-2' });
    assert.equal(run.call('memory_propose', { sourceTurnId: 't-2', kind: 'preference', body: '回复里不加 emoji' }).status, 'dropped', 'same body as a pending memory');
    assert.equal(run.call('memory_propose', { sourceTurnId: 't-2', kind: 'preference', body: '回复别加表情符号' }).status, 'staged');
    // The user deletes the explicit memory from t-1 and rejects a pending one with t-2's new body while this run is still working.
    now += 1_000;
    deleteMemory({ ownerUserId: OWNER }, saved.id);
    const lookalike = createMemory({ ownerUserId: OWNER }, { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'preference',
      body: '回复别加表情符号', status: 'pending', origin: 'extracted', source: { turnId: 'older-turn-2' } });
    rejectMemory({ ownerUserId: OWNER }, lookalike.id);
  };
  await runOnce(sched, model, jobId);
  assert.equal(lastRun(sched, jobId).status, 'succeeded');
  assert.deepEqual(extracted().map((memory) => memory.id), [earlier.id], 'both staged candidates were dropped at commit');
  assert.match(lastRun(sched, jobId).summary ?? '', /dropped 3/);

  // The same preference said again in a new turn is a new explicit statement.
  now += MINUTE;
  completeTurn({ turnId: 't-3', user: '再说一次：回复别加表情符号。', reply: '好的。' });
  model.script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-3' });
    assert.equal(run.call('memory_propose', { sourceTurnId: 't-3', kind: 'preference', body: '回复别加表情符号' }).status, 'staged');
  };
  await runOnce(sched, model, jobId);
  assert.ok(extracted().some((memory) => memory.body === '回复别加表情符号' && memory.source?.turnId === 't-3'));
});

// ── purge ────────────────────────────────────────────────────────────────────

test('workspace and owner purges remove extraction state, receipts, tombstones and usage', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  addWorkspace('ws-2');
  const jobId = await enableAuto(sched);
  completeTurn({ turnId: 't-1', user: 'This repo uses pnpm.', reply: 'OK.' });
  model.script = (run) => {
    run.call('memory_read_source', { sourceTurnId: 't-1' });
    run.call('memory_propose', { sourceTurnId: 't-1', kind: 'convention', body: 'This repo uses pnpm' });
    return { usage: 100 };
  };
  await runOnce(sched, model, jobId);
  deleteMemory({ ownerUserId: OWNER }, extracted()[0]!.id);
  for (const table of ['memory_extraction_runs', 'memory_extraction_sources', 'memory_extraction_candidates', 'memory_extraction_proposals', 'memory_extraction_tombstones']) {
    assert.ok(rowCount(table) > 0, `${table} has rows before the purge`);
  }
  deleteWorkspace('ws');
  for (const table of ['memory_extraction_runs', 'memory_extraction_sources', 'memory_extraction_candidates', 'memory_extraction_proposals', 'memory_extraction_tombstones']) {
    assert.equal(rowCount(table), 0, `${table} after the workspace purge`);
  }
  assert.equal(rowCount('memory_extraction_cursors', 'workspace_id = ?', 'ws'), 0);
  assert.equal(rowCount('memory_extraction_cursors', 'workspace_id = ?', 'ws-2'), 1, 'other workspaces keep theirs');

  createMemory({ ownerUserId: OWNER }, { scope: { kind: 'user' }, kind: 'preference', body: 'Short answers', status: 'active', origin: 'explicit' });
  deleteMemory({ ownerUserId: OWNER }, listMemories({ ownerUserId: OWNER }).items[0]!.id);
  assert.equal(rowCount('memory_extraction_tombstones', 'workspace_id IS NULL'), 1);
  purgeOwnerMemories(OWNER);
  for (const table of ['memory_extraction_cursors', 'memory_extraction_tombstones', 'memory_extraction_usage', 'memory_extraction_state']) {
    assert.equal(rowCount(table, 'owner_user_id = ?', OWNER), 0, `${table} after the owner purge`);
  }
});

// ── fixtures through a scripted runtime ──────────────────────────────────────

/** Seeds a fixture conversation as completed turns: each user message starts a turn; tool output joins its reply. */
function seedFixture(item: ExtractionFixtureCase): string[] {
  const groups: Array<{ user: string; replies: string[]; untrusted: boolean }> = [];
  for (const turn of item.turns as ExtractionFixtureTurn[]) {
    if (turn.role === 'user') { groups.push({ user: turn.text, replies: [], untrusted: false }); continue; }
    if (!groups.length) groups.push({ user: '(earlier request)', replies: [], untrusted: false });
    const group = groups[groups.length - 1]!;
    group.replies.push(turn.role === 'tool' ? `[tool output]\n${turn.text}` : turn.text);
    if (turn.untrusted) group.untrusted = true;
  }
  return groups.map((group, index) => completeTurn({ turnId: `${item.id}-${index}`, nodeId: `fixture-${item.id}`, user: group.user,
    reply: group.replies.join('\n\n') || 'OK.', untrusted: group.untrusted }));
}

test('fixture cases through a scripted runtime: candidates, scope hints, correction hints, supersedes and no-change receipts', async () => {
  const model = new FakeModel();
  const sched = scheduler(model);
  const jobId = await enableAuto(sched);
  const pick = (set: 'positive' | 'negative' | 'correction', ids: string[]) => {
    const cases = loadExtractionFixtures(set);
    return ids.map((id) => { const found = cases.find((item) => item.id === id); assert.ok(found, id); return found; });
  };
  const cases = [
    ...pick('positive', ['zh-reply-language-and-comment-language', 'zh-package-manager-convention', 'zh-user-rule-beside-untrusted-page', 'en-decision-confirmed-lru-cache']),
    ...pick('negative', ['zh-temporary-todo', 'zh-injection-in-web-page', 'zh-temporary-meeting-correction', 'en-unconfirmed-orm-proposal']),
    ...pick('correction', ['zh-not-but-indent-width', 'en-switch-back-npm', 'zh-change-to-vitest']),
  ];
  const old = createMemory({ ownerUserId: OWNER }, { scope: { kind: 'workspace', workspaceId: 'ws' }, kind: 'convention',
    body: '缩进用 4 个空格', status: 'active', origin: 'explicit' });

  for (const item of cases) {
    const turnIds = seedFixture(item);
    const before = new Set(extracted().map((memory) => memory.id));
    let hint: string | undefined;
    model.script = (run) => {
      assert.deepEqual(run.index.map((entry) => entry.sourceTurnId), turnIds, item.id);
      const decision = turnIds[turnIds.length - 1]!;
      for (const turnId of turnIds) {
        const read = run.call('memory_read_source', { sourceTurnId: turnId });
        assert.ok(read.messages.some((message: { role: string }) => message.role === 'assistant'), `${item.id}: the reply is read too`);
        if (turnId !== decision || item.expected.candidates.length === 0) {
          run.call('memory_no_change', { sourceTurnId: turnId, reason: 'nothing durable from the user here' });
          if (turnId === decision) hint = read.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.correctionHint;
          continue;
        }
        hint = read.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.correctionHint;
        for (const candidate of item.expected.candidates) {
          const found = run.call('memory_search', { query: candidate.bodyIncludes.at(-1)! }).memories as Array<{ id: string; status: string }>;
          const supersedes = item.expected.correction ? found.find((memory) => memory.status === 'active')?.id : undefined;
          run.call('memory_propose', { sourceTurnId: turnId, kind: candidate.kind, scopeHint: candidate.scopeHint,
            body: `${candidate.bodyIncludes.join(' ')} (${item.id})`, ...(supersedes ? { supersedesId: supersedes } : {}) });
        }
      }
    };
    await runOnce(sched, model, jobId);
    assert.equal(lastRun(sched, jobId).status, 'succeeded', `${item.id}: ${lastRun(sched, jobId).error}`);
    if (item.expected.correction) assert.equal(hint, item.expected.correction.pattern, `${item.id}: correction hint`);
    const added = extracted().filter((memory) => !before.has(memory.id));
    assert.equal(added.length, item.expected.candidates.length, `${item.id}: candidates`);
    const maybeGlobal = new Set(memoryExtractionStatus(OWNER, now, sched).maybeGlobalMemoryIds);
    for (const candidate of item.expected.candidates) {
      const memory = added.find((entry) => candidate.bodyIncludes.every((part) => entry.body.includes(part)) && entry.kind === candidate.kind);
      assert.ok(memory, `${item.id}: ${candidate.bodyIncludes.join(', ')}`);
      assert.equal(memory.status, 'pending');
      assert.equal(memory.sourceRisk, null, `${item.id}: the user's own statement is in a trusted turn`);
      assert.equal(maybeGlobal.has(memory.id), candidate.scopeHint === 'maybe_global', `${item.id}: scope hint`);
      if (item.id === 'zh-not-but-indent-width') {
        assert.equal(memory.supersedesId, old.id);
        approveMemory({ ownerUserId: OWNER }, memory.id);
        assert.equal(listMemories({ ownerUserId: OWNER }, { status: ['superseded'] }).items[0]?.id, old.id);
      }
    }
  }
  assert.equal(getExtractionCursor('ws', OWNER)!.completionCursor, Number((getDb().prepare("SELECT value FROM meta WHERE key='conversation_completion_seq:ws'").get() as { value: string }).value));
});
