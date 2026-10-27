import { UNKNOWN_RUNTIME_DESCRIPTOR } from 'michi-runtime';
// Must stay first: agentConfig would otherwise persist these fixtures to ~/.michi/config.json.
import './isolatedConfigDir';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent, type PageWriteResult } from 'michi-shared';
import type { AgentRuntime, AgentSession } from '../src/agents/types';
import { registerRuntime } from '../src/agents/registry';
import { updateMetaAgentSettings } from '../src/services/metaAgent/settings';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getMaintenanceConfig } from '../src/services/pages/maintenanceRepository';
import { createMaintenanceTools } from '../src/services/pages/maintenanceTools';
import type { MaintenanceExecutionContext } from '../src/services/pages/maintenanceWriter';
import { getPage } from '../src/services/pages/repository';
import { getFirstRun } from '../src/services/pages/firstRun';
import { ensureSpacesHomePageId, getWorkspaceHome, listWorkspaceHomes } from '../src/services/pages/homePages';
import { saveLayoutPreferences } from '../src/services/pages/layoutRules';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository, type ScheduledJobRecord, type ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import {
  ScheduledJobScheduler, type ScheduledJobExecutor, type ScheduledRunHandle, type ScheduledRunHooks, type ScheduledRunOutcome,
} from '../src/services/scheduledJobs/scheduler';
import { planHomeRun, retrySpacesFirstRun, spacesFirstRunStatus, startSpacesFirstRun } from '../src/services/metaAgent/firstRun';
import { getHomeState } from '../src/services/metaAgent/firstRunStore';
import { configureHomeCardsSink, type HomeCardsWrite } from '../src/services/metaAgent/homeCardsGenerator';
import { ensureAssistant } from '../src/assistant/store';
import { ASSISTANT_TOOLS } from '../src/assistant/tools';
import type { StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from '../src/agents/chatHub';
import { configureThreadMessaging, type ThreadMessagingDeps } from '../src/agents/threadMessageTool';
import { withMetaAgentContext } from '../src/services/metaAgent/chatTurnContext';
import { firstRunTurnNote, holdWindowPageWrite, resumeHeldEdits } from '../src/services/metaAgent/firstRunHold';
import { parseFirstRunEnd } from '../src/services/metaAgent/firstRunNarration';
import { saveMessage } from '../src/services/dbRepository';

const OWNER = 'local-user';
const DAY = 86_400_000;

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
let cardWrites: HomeCardsWrite[] = [];

type ToolResult = { isError?: boolean; content: Array<{ text: string }>; details?: unknown };

interface ModelRun {
  job: ScheduledJobRecord;
  run: ScheduledJobRunRecord;
  hooks: ScheduledRunHooks;
  runId: string;
  call<T = any>(name: string, args: Record<string, unknown>): T;
  attempt(name: string, args: Record<string, unknown>): ToolResult;
}
type Script = (run: ModelRun) => Promise<{ outcome?: ScheduledRunOutcome; reply?: string } | void> | { outcome?: ScheduledRunOutcome; reply?: string } | void;

/** Stands in for the runtime: drives the maintenance tools with each run's server-bound context. */
class FakeModel implements ScheduledJobExecutor {
  processExitStopsExecution = true;
  started: ModelRun[] = [];
  script: (run: ModelRun) => Script = () => () => {};

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
    const base = hooks.maintenanceContext!;
    const context = { ...base, execution: { nodeId, turnId, assistantId, runId: run.id } } as MaintenanceExecutionContext;
    const tools = () => createMaintenanceTools(context, { now: () => now });
    const attempt = (name: string, args: Record<string, unknown>) => tools().find((tool) => tool.name === name)!.execute(args) as ToolResult;
    const modelRun: ModelRun = { job, run, hooks, runId: base?.planId, attempt,
      call: (name, args) => { const result = attempt(name, args); assert.notEqual(result.isError, true, result.content[0]?.text); return result.details as any; } };
    this.started.push(modelRun);
    let cancel!: () => void;
    const cancelled = new Promise<ScheduledRunOutcome>((resolve) => { cancel = () => resolve({ status: 'cancelled', summary: null, error: null }); });
    const script = this.script(modelRun);
    const work = (async (): Promise<ScheduledRunOutcome> => {
      await flush();
      const result = (await script(modelRun)) ?? {};
      turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: result.reply ?? 'Done.' } } as ChatStreamEvent);
      finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
      return result.outcome ?? { status: 'succeeded', summary: 'done', error: null };
    })();
    return { nodeId, treeId: null, turnId, done: Promise.race([work, cancelled]), cancel };
  }
}

function flush(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
/** Waits for a condition; the scheduler's own timer waits a real second between runs, so idle due jobs are ticked here. */
async function until(predicate: () => boolean, label = 'condition', sched?: ScheduledJobScheduler): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await flush();
    if (sched && i % 10 === 9 && idle(sched)) await sched.tick();
  }
  assert.fail(`${label} did not become true`);
}

let conversationSeq = 0;
function conversation(workspaceId: string, title: string, at: number, text = `About ${title}`): string {
  const nodeId = `node-${++conversationSeq}`;
  getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES(?,?,'chat','idle',?,?)").run(nodeId, workspaceId, title, at);
  let turn = createDurableTurn({ turnId: `turn-${conversationSeq}`, assistantId: `assistant-${conversationSeq}`, nodeId, workspaceId,
    displayUserText: text, startedAt: at });
  beginTurn(turn);
  turn = applyTurnEvent(turn, { event: 'chunk', data: { seq: 1, text: `Reply on ${title}` } } as ChatStreamEvent);
  finalizeTurn(applyTurnEvent(turn, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
  return nodeId;
}

function workspace(id: string, name: string, createdAt = 1): void {
  getDb().prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(id, name, createdAt, createdAt);
}

function scheduler(model: FakeModel, instanceId = 'first-run-test'): ScheduledJobScheduler {
  const created = new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor: model,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: (id) => id === 'pi',
    clock: () => now, instanceId, createId: () => `job-${++jobSeq}`, pollIntervalMs: 600_000, maxConcurrentRuns: 1, cancelGraceMs: 5 });
  created.start();
  return created;
}

const homeOf = (workspaceId: string) => listWorkspaceHomes(OWNER).find((home) => home.workspaceId === workspaceId)!.homePageId!;
const idle = (sched: ScheduledJobScheduler) => sched.listJobs().every((job) => job.activeRunId === null);

/** A model that reads the listed history and writes one home. */
function writesHome(run: ModelRun, label: string) {
  const list = run.call('list_threads', {});
  for (const entry of list.conversations) run.call('read_node_overview', { nodeId: entry.nodeId });
  const pageId = homeOf(run.job.workspaceId);
  run.call('maintenance_read_page', { sourceTurnId: run.runId, pageId });
  return run.call<PageWriteResult>('maintenance_write_page', { sourceTurnId: run.runId, pageId, ops: [
    { op: 'insert', block: { type: 'callout', text: `${label}: ${list.total} conversations`, tone: 'info' }, after: null },
  ] });
}

const CARDS = (workspaceId: string, since: number) => `Summary written.\n\`\`\`json\n${JSON.stringify({
  greeting: { text: 'Good morning.', detail: `ws-a moved {{days:${since}}} days ago` },
  sets: [{ cards: [
    { id: 'continue-a', kind: 'continue', label: 'Workspace A', title: 'Pick up A', reason: `Idle for {{days:${since}}} days`,
      buttonText: 'Continue', prompt: 'Continue A', workspaceId, source: { workspaceId } },
    { id: 'bogus', kind: 'try', label: 'Nowhere', title: 'Made up', reason: 'x', buttonText: 'Go', prompt: 'x', workspaceId: 'ws-missing', source: {} },
    { id: 'tip-1', kind: 'tip', label: 'Tip', title: 'Branch', reason: 'Branches keep context', buttonText: 'Try', prompt: 'Branch this', workspaceId: null, source: { workspaceId: null } },
    { id: 'tip-2', kind: 'tip', label: 'Tip', title: 'Second tip', reason: 'One tip per set', buttonText: 'Try', prompt: 'x', workspaceId: null, source: {} },
  ] }],
})}\n\`\`\``;

/** A model that reads only the workspace homes and writes the Spaces Home. */
function writesSummary(run: ModelRun, since: number) {
  const listed = run.call('maintenance_read_workspace_home', {});
  for (const home of listed.workspaces) if (home.homePageId && home.firstRun === 'done') run.call('maintenance_read_workspace_home', { workspaceId: home.workspaceId });
  const pageId = ensureSpacesHomePageId(OWNER);
  run.call('maintenance_read_page', { sourceTurnId: run.runId, pageId });
  run.call('maintenance_write_page', { sourceTurnId: run.runId, pageId, ops: [
    { op: 'insert', block: { type: 'callout', text: `Summary of ${listed.workspaces.length} workspaces` }, after: null },
  ] });
  return { reply: CARDS('ws-a', since) };
}

interface WindowMessage { id: string; text: string; kind: string; workspaceId?: string; options?: Array<{ label: string; open?: unknown }> }

/** The Meta agent window conversation's messages Michi posted for the first run, in order. */
function windowNarration(): WindowMessage[] {
  const nodeId = ensureAssistant().nodeId;
  return (getDb().prepare('SELECT id, content, metadata FROM messages WHERE node_id=? ORDER BY seq').all(nodeId) as Array<{ id: string; content: string; metadata: string | null }>)
    .filter((row) => row.metadata?.includes('metaAgentNarration'))
    .map((row) => ({ id: row.id, text: row.content, ...JSON.parse(row.metadata!).metaAgentNarration }));
}

beforeEach(() => {
  priorDataDir = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-meta-first-run-'));
  process.env.MICHI_DATA_DIR = tmpDir;
  delete process.env.MICHI_CLOUD;
  closeDb();
  initDb();
  now = Date.parse('2026-10-23T09:00:00Z');
  mock.method(Date, 'now', () => now);
  jobSeq = 0;
  conversationSeq = 0;
  cardWrites = [];
  configureHomeCardsSink({ write: (_owner, cards) => { cardWrites.push(cards); } });
  updateMetaAgentSettings({ runtimeId: 'pi' });
});

afterEach(() => {
  configureHomeCardsSink(null);
  mock.restoreAll();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
});

test('first run writes each workspace home newest first, then the Spaces Home and cards, and stays quiet without new input', async () => {
  // Created B first: the run order follows conversation activity, not creation.
  workspace('ws-b', 'Workspace B', 1); workspace('ws-a', 'Workspace A', 2); workspace('ws-empty', 'Empty', 3); workspace('ws-stale', 'Stale', 4);
  conversation('ws-b', 'Older plan', now - 2 * DAY);
  const a1 = conversation('ws-a', 'Release', now - 2 * 3_600_000);
  conversation('ws-a', 'Bug bash', now - 3_600_000);
  conversation('ws-stale', 'Long ago', now - 40 * DAY);
  const workspaceHome = getWorkspaceHome('ws-a', OWNER).page.id;
  saveLayoutPreferences({ pageId: workspaceHome, ownerUserId: OWNER, text: 'Lead with the release risks', expectedRevision: 0, actor: 'user' });
  saveLayoutPreferences({ pageId: ensureSpacesHomePageId(OWNER), ownerUserId: OWNER, text: 'Compare decisions across workspaces', expectedRevision: 0, actor: 'user' });
  const model = new FakeModel();
  const sched = scheduler(model);
  const progress: Array<string> = [];
  model.script = (run) => (current) => {
    if (run.job.workspaceId === 'ws-a' && model.started.length === 1) {
      assert.match(run.job.prompt, /First-time generation of the default home page for the workspace "Workspace A"/);
      assert.match(run.job.prompt, /Lead with the release risks/);
      assert.doesNotMatch(run.job.prompt, /Compare decisions across workspaces/);
      // The workspace home lists its conversations itself, so the agent writes no second list of them.
      assert.doesNotMatch(run.job.prompt, /Related conversations/);
      assert.equal(run.hooks.maintenanceContext?.sources.length, 0);
      assert.equal(run.hooks.conversationBatch, undefined);
      const record = () => { const p = getFirstRun('ws-a', OWNER)!; progress.push(`${p.state}:${p.readCount}/${p.total}`); };
      record();
      const listed = current.call('list_threads', {});
      assert.deepEqual(listed.conversations.map((entry: { title: string }) => entry.title), ['Bug bash', 'Release']);
      record();
      assert.match(current.call('read_node', { nodeId: a1 }).text, /Reply on Release/);
      assert.match(current.attempt('read_node', { nodeId: 'node-1' }).content[0]!.text, /not in this workspace/);
      assert.match(current.attempt('maintenance_route_source', { sourceTurnId: current.runId, candidates: [] }).content[0]!.text, /not used while/);
      assert.match(current.attempt('maintenance_read_workspace_home', {}).content[0]!.text, /only read for the Spaces Home summary/);
      const pageId = homeOf('ws-a');
      assert.match(current.attempt('maintenance_write_page', { sourceTurnId: current.runId, pageId: ensureSpacesHomePageId(OWNER),
        ops: [{ op: 'insert', block: { type: 'markdown', text: 'x' }, after: null }] }).content[0]!.text, /only read and write its own home/);
      current.call('maintenance_read_page', { sourceTurnId: current.runId, pageId });
      record();
      const ops = [{ op: 'insert', block: { type: 'callout', text: 'A ships this week' }, after: null },
        { op: 'insert', block: { type: 'heading', text: 'Next steps' }, after: null }];
      const written = current.call<PageWriteResult>('maintenance_write_page', { sourceTurnId: current.runId, pageId, ops });
      assert.equal(written.applied.length, 2);
      record();
      assert.deepEqual(current.call('maintenance_write_page', { sourceTurnId: current.runId, pageId, ops }), written);
      assert.match(current.attempt('maintenance_write_page', { sourceTurnId: current.runId, pageId,
        ops: [{ op: 'insert', block: { type: 'markdown', text: 'again' }, after: null }] }).content[0]!.text, /already finished/);
      return;
    }
    if (run.job.workspaceId === 'ws-b' && /First-time/.test(run.job.prompt)) { writesHome(current, 'B'); return; }
    if (/Spaces Home summary/.test(run.job.prompt)) {
      assert.match(run.job.prompt, /Compare decisions across workspaces/);
      assert.doesNotMatch(run.job.prompt, /Lead with the release risks/);
      const result = writesSummary(current, now - 3 * DAY);
      // Written but not settled: another job's tick must neither rerun nor settle it.
      const other = getMaintenanceConfig('ws-b', OWNER)!.jobId;
      assert.equal(planHomeRun({ workspaceId: 'ws-b', ownerUserId: OWNER, jobId: other, runId: 'run-other', now }), null);
      assert.equal(getHomeState(OWNER)?.summarizedAt, null);
      return result;
    }
    assert.fail(`unexpected run: ${run.job.prompt.slice(0, 60)}`);
  };
  try {
    const status = startSpacesFirstRun(sched, OWNER, now);
    const state = (id: string) => status.workspaces.find((home) => home.workspaceId === id)!.firstRun;
    assert.equal(state('ws-empty')?.state, 'done');
    assert.equal(state('ws-empty')?.total, 0);
    assert.equal(state('ws-stale')?.state, 'done');
    assert.equal(state('ws-a')?.total, 2);
    assert.equal(state('ws-a')?.startSeq, 2);

    await until(() => model.started.length === 2 && idle(sched), 'both first runs', sched);
    assert.deepEqual(model.started.map((run) => run.job.workspaceId), ['ws-a', 'ws-b']);
    assert.deepEqual(progress, ['reading:0/2', 'reading:2/2', 'writing:2/2', 'done:2/2']);
    assert.equal(getFirstRun('ws-b', OWNER)?.state, 'done');
    assert.equal(getMaintenanceConfig('ws-a', OWNER)?.completionCursor, 2);
    assert.equal(sched.getJob(getMaintenanceConfig('ws-a', OWNER)!.jobId).lastStatus, 'succeeded');
    const change = getDb().prepare('SELECT source FROM page_changes WHERE page_id=? ORDER BY seq LIMIT 1').get(homeOf('ws-a')) as { source: string };
    const source = JSON.parse(change.source);
    assert.equal(source.kind, 'maintenance');
    // These blocks named no sources: they cite no message, only what the run read.
    assert.deepEqual([source.evidence, source.read], [[], { kind: 'conversations', count: 2 }]);
    assert.equal(model.started.some((run) => run.job.workspaceId === 'ws-empty'), false);

    now += 61_000;
    await sched.tick();
    await until(() => model.started.length === 3 && idle(sched), 'summary run', sched);
    assert.match(model.started[2]!.job.prompt, /Spaces Home summary/);
    // One heading for the focus block: the checklist's own title.
    assert.match(model.started[2]!.job.prompt, /a checklist titled "This week's focus".*add no separate heading block/);
    const spacesHome = getPage(ensureSpacesHomePageId(OWNER), OWNER);
    assert.equal(spacesHome.blocks[0]?.type, 'callout');
    assert.equal(spacesFirstRunStatus(OWNER, now).summary.state, 'done');
    assert.equal(cardWrites.length, 1);
    assert.equal(cardWrites[0]!.greeting?.detail, 'ws-a moved 3 days ago');
    assert.deepEqual(cardWrites[0]!.sets[0]!.cards.map((card) => card.id), ['continue-a', 'tip-1']);
    assert.equal(cardWrites[0]!.sets[0]!.cards[0]!.reason, 'Idle for 3 days');

    // Nothing new: the minute ticks open no model turn and leave the cards alone.
    for (let i = 0; i < 3; i += 1) { now += 61_000; await sched.tick(); await until(() => idle(sched)); }
    assert.equal(model.started.length, 3);
    assert.equal(cardWrites.length, 1);

    // Next day: the date wording moves without a model call.
    now += DAY;
    await sched.tick(); await until(() => idle(sched));
    assert.equal(model.started.length, 3);
    assert.equal(cardWrites.length, 2);
    assert.equal(cardWrites[1]!.sets[0]!.cards[0]!.reason, 'Idle for 4 days');

    // A person's edit to a workspace home is not new input; an Agent block change is.
    const homeB = homeOf('ws-b');
    const blocks = getPage(homeB, OWNER).blocks;
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify([...blocks, { id: 'block-human', type: 'markdown', text: 'mine', rev: 9, edit: { at: now } }]), homeB);
    now += 61_000; await sched.tick(); await until(() => idle(sched));
    assert.equal(model.started.length, 3);
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify([...blocks, { id: 'block-agent', type: 'markdown', text: 'B shipped', rev: 9,
      sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] }]), homeB);
    now += 61_000; await sched.tick();
    await until(() => model.started.length === 4 && idle(sched), 'second summary', sched);
    assert.match(model.started[3]!.job.prompt, /Spaces Home summary/);
  } finally {
    await sched.stop();
  }
});

test('each first-run block cites the messages it came from, only ones the run read, and the summary records how many homes it read', async () => {
  workspace('ws-a', 'Workspace A');
  const release = conversation('ws-a', 'Release', now - 2 * 3_600_000, 'Notarize the 0.9 build');
  const bugs = conversation('ws-a', 'Bug bash', now - 3_600_000);
  const model = new FakeModel();
  const sched = scheduler(model);
  let firstRun: (PageWriteResult & { sourceNotes?: string[] }) | null = null;
  model.script = (run) => (current) => {
    if (/First-time/.test(run.job.prompt)) {
      assert.match(run.job.prompt, /Give every insert and update its sources/);
      current.call('list_threads', {});
      // Only Release is read message by message; Bug bash is only listed.
      assert.match(current.call('read_node', { nodeId: release }).text, /^assistant \[message assistant-1\]: Reply on Release$/m);
      const pageId = homeOf('ws-a');
      current.call('maintenance_read_page', { sourceTurnId: current.runId, pageId });
      firstRun = current.call('maintenance_write_page', { sourceTurnId: current.runId, pageId, ops: [
        { op: 'insert', block: { type: 'markdown', text: 'no sources' }, after: null },
        { op: 'insert', block: { type: 'markdown', text: 'fake' }, after: null,
          sources: [{ nodeId: release, messageId: 'assistant-404' }, { nodeId: 'node-elsewhere', messageId: 'assistant-1' }] },
        { op: 'insert', block: { type: 'markdown', text: 'listed only' }, after: null, sources: [{ nodeId: bugs, messageId: 'assistant-2' }] },
        { op: 'insert', block: { type: 'markdown', text: 'asked' }, after: null, sources: [{ nodeId: release, messageId: 'u-assistant-1' }] },
        { op: 'insert', block: { type: 'callout', text: 'shipped' }, after: null,
          sources: [{ nodeId: release, messageId: 'assistant-1' }, { nodeId: release, messageId: 'assistant-1' }] },
      ] });
      return;
    }
    if (/Spaces Home summary/.test(run.job.prompt)) {
      const listed = current.call('maintenance_read_workspace_home', {});
      for (const home of listed.workspaces) current.call('maintenance_read_workspace_home', { workspaceId: home.workspaceId });
      const pageId = ensureSpacesHomePageId(OWNER);
      current.call('maintenance_read_page', { sourceTurnId: current.runId, pageId });
      const written = current.call('maintenance_write_page', { sourceTurnId: current.runId, pageId, ops: [
        { op: 'insert', block: { type: 'callout', text: 'All workspaces' }, after: null, sources: [{ nodeId: release, messageId: 'assistant-1' }] },
      ] });
      assert.equal(written.sourceNotes.length, 1, 'a summary cites the homes, not conversations');
      return { reply: CARDS('ws-a', now) };
    }
    assert.fail(`unexpected run: ${run.job.prompt.slice(0, 60)}`);
  };
  const sources = (pageId: string): Record<string, any> => Object.fromEntries((getDb().prepare('SELECT source,after_json FROM page_changes WHERE page_id=? ORDER BY seq')
    .all(pageId) as Array<{ source: string; after_json: string }>).map((row) => [JSON.parse(row.after_json).block.text, JSON.parse(row.source)]));
  try {
    startSpacesFirstRun(sched, OWNER, now);
    await until(() => model.started.length === 1 && idle(sched), 'first run', sched);
    const cited = sources(homeOf('ws-a'));
    const read = { kind: 'conversations', count: 2 };
    assert.deepEqual(cited.shipped.evidence, [{ nodeId: release, turnId: 'turn-1', assistantId: 'assistant-1' }]);
    assert.deepEqual(cited.asked.evidence, [{ nodeId: release, turnId: 'turn-1', assistantId: 'assistant-1', messageId: 'u-assistant-1' }]);
    for (const text of ['no sources', 'fake', 'listed only']) assert.deepEqual([cited[text].evidence, cited[text].read], [[], read], text);
    assert.deepEqual(cited.shipped.read, read);
    // The conversation column names a cited conversation, never the run that only wrote the block.
    const nodeOf = (text: string) => (getDb().prepare("SELECT source_node_id FROM page_changes WHERE page_id=? AND json_extract(after_json,'$.block.text')=?")
      .get(homeOf('ws-a'), text) as { source_node_id: string | null }).source_node_id;
    assert.deepEqual([nodeOf('shipped'), nodeOf('no sources')], [release, null]);
    assert.equal(firstRun!.sourceNotes?.length, 3);
    assert.match(firstRun!.sourceNotes!.join('\n'), /Operation 1: message assistant-404 was not cited \(not a message read_node showed/);
    assert.match(firstRun!.sourceNotes!.join('\n'), /Operation 2: message assistant-2 was not cited/);

    now += 61_000;
    await sched.tick();
    await until(() => model.started.length === 2 && idle(sched), 'summary run', sched);
    const summary = Object.values(sources(ensureSpacesHomePageId(OWNER)))[0];
    assert.deepEqual([summary.evidence, summary.read], [[], { kind: 'workspace-homes', count: 1 }]);
  } finally {
    await sched.stop();
  }
});

test('a failing workspace does not stop the others, and the summary names what is missing', async () => {
  workspace('ws-a', 'Workspace A'); workspace('ws-b', 'Workspace B');
  conversation('ws-a', 'Newest', now - 3_600_000);
  conversation('ws-b', 'Older', now - DAY);
  const model = new FakeModel();
  const sched = scheduler(model);
  model.script = (run) => (current) => {
    if (/Spaces Home summary/.test(run.job.prompt)) {
      assert.match(run.job.prompt, /Workspace A \(ws-a\): first-time generation failed: Provider quota exhausted/);
      return writesSummary(current, now);
    }
    if (run.job.workspaceId === 'ws-a') return { outcome: { status: 'failed', summary: null, error: 'Provider quota exhausted' } };
    writesHome(current, 'B');
  };
  try {
    startSpacesFirstRun(sched, OWNER, now);
    await until(() => model.started.length === 2 && idle(sched), 'both first runs', sched);
    assert.equal(getFirstRun('ws-a', OWNER)?.state, 'failed');
    assert.equal(getFirstRun('ws-a', OWNER)?.error, 'Provider quota exhausted');
    assert.equal(getFirstRun('ws-b', OWNER)?.state, 'done');
    now += 61_000; await sched.tick();
    await until(() => model.started.length === 3 && idle(sched), 'summary despite the failure', sched);
    assert.equal(spacesFirstRunStatus(OWNER, now).summary.state, 'done');

    const homeA = homeOf('ws-a');
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify([{ id: 'block-mine', type: 'markdown', text: 'My notes', rev: 1, edit: { at: now } }]), homeA);
    let rewrite: PageWriteResult | undefined;
    model.script = (run) => (current) => {
      if (!/First-time/.test(run.job.prompt)) return writesSummary(current, now);
      current.call('list_threads', {});
      current.call('maintenance_read_page', { sourceTurnId: current.runId, pageId: homeA });
      rewrite = current.call<PageWriteResult>('maintenance_write_page', { sourceTurnId: current.runId, pageId: homeA, ops: [
        { op: 'update', id: 'block-mine', expectRev: 1, block: { type: 'markdown', text: 'Agent rewrite' } },
        { op: 'insert', block: { type: 'callout', text: 'A is back' }, after: null },
      ] });
    };
    const retried = retrySpacesFirstRun(sched, OWNER, 'ws-a', now);
    assert.equal(retried.workspaces.find((home) => home.workspaceId === 'ws-a')!.firstRun?.state, 'queued');
    await until(() => model.started.length === 4 && idle(sched), 'retried first run', sched);
    assert.equal(getFirstRun('ws-a', OWNER)?.state, 'done');
    assert.equal(getFirstRun('ws-b', OWNER)?.state, 'done');
    assert.equal(rewrite?.applied.length, 1);
    assert.equal(rewrite?.proposed.length, 1, 'a person\'s block is only proposed');
    const mine = getPage(homeA, OWNER).blocks.find((block) => block.id === 'block-mine') as { text?: string } | undefined;
    assert.equal(mine?.text, 'My notes');
  } finally {
    await sched.stop();
  }
});

test('a restart resumes an unfinished first run without rewriting a finished home', async () => {
  workspace('ws-a', 'Workspace A'); workspace('ws-b', 'Workspace B');
  conversation('ws-a', 'One', now - 3_600_000); conversation('ws-a', 'Two', now - 2 * 3_600_000);
  conversation('ws-b', 'Older', now - DAY);
  const model = new FakeModel();
  let first = scheduler(model, 'before-restart');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  model.script = (run) => async (current) => {
    if (run.job.workspaceId === 'ws-a') { writesHome(current, 'A'); return; }
    current.call('list_threads', { limit: 1 });
    await hold;
  };
  try {
    startSpacesFirstRun(first, OWNER, now);
    await until(() => model.started.length === 2 && getFirstRun('ws-b', OWNER)?.readCount === 1, 'second run mid-read', first);
    assert.equal(getFirstRun('ws-a', OWNER)?.state, 'done');
    assert.deepEqual(windowNarration().map((entry) => [entry.kind, entry.workspaceId]), [['start', undefined], ['workspace', 'ws-a']]);
    const homeA = getPage(homeOf('ws-a'), OWNER).revision;
    await first.stop();
    release();
    const claims = () => (getDb().prepare('SELECT COUNT(*) AS n FROM scheduler_execution_claims').get() as { n: number }).n;
    await until(() => claims() === 0, 'the stopped execution to end');
    assert.equal(getFirstRun('ws-b', OWNER)?.state, 'reading');

    model.script = (run) => (current) => {
      assert.equal(run.job.workspaceId, 'ws-b');
      assert.equal(getFirstRun('ws-b', OWNER)?.readCount, 1);
      writesHome(current, 'B');
    };
    now += 91_000;
    first = scheduler(model, 'after-restart');
    startSpacesFirstRun(first, OWNER, now);
    await until(() => model.started.length === 3 && idle(first), 'resumed run', first);
    assert.equal(getFirstRun('ws-b', OWNER)?.state, 'done');
    startSpacesFirstRun(first, OWNER, now);
    assert.deepEqual(windowNarration().map((entry) => [entry.kind, entry.workspaceId]),
      [['start', undefined], ['workspace', 'ws-a'], ['workspace', 'ws-b']], 'the restart posted only what was still to come');
    assert.equal(getFirstRun('ws-b', OWNER)?.readCount, 1);
    assert.equal(getPage(homeOf('ws-a'), OWNER).revision, homeA);
    assert.equal(model.started.filter((run) => run.job.workspaceId === 'ws-a').length, 1);
  } finally {
    release();
    await first.stop();
  }
});

test('a failed restriction check stops later home runs until a retry', async () => {
  workspace('ws-a', 'Workspace A'); workspace('ws-b', 'Workspace B');
  conversation('ws-a', 'Newest', now - 3_600_000);
  conversation('ws-b', 'Older', now - DAY);
  const model = new FakeModel();
  const sched = scheduler(model);
  model.script = () => () => ({ outcome: { status: 'failed', summary: null, error: 'Meta agent restriction check failed on pi: bash' } });
  try {
    startSpacesFirstRun(sched, OWNER, now);
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'failed' && idle(sched), 'the first workspace stopped', sched);
    now += 61_000; await sched.tick(); await until(() => idle(sched));
    assert.equal(model.started.length, 1, 'the second workspace never opened a session');
    assert.notEqual(getFirstRun('ws-b', OWNER)?.state, 'done', 'the second workspace waits while maintenance is held');
    assert.match(spacesFirstRunStatus(OWNER, now).haltedReason ?? '', /restriction check failed/);
    now += 61_000; await sched.tick(); await until(() => idle(sched));
    assert.equal(model.started.length, 1, 'no summary while stopped');

    model.script = () => (current) => { writesHome(current, 'ok'); };
    retrySpacesFirstRun(sched, OWNER, null, now);
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'done' && getFirstRun('ws-b', OWNER)?.state === 'done' && idle(sched), 'both retried', sched);
    assert.equal(spacesFirstRunStatus(OWNER, now).haltedReason, null);
  } finally {
    await sched.stop();
  }
});

test('a workspace created after Spaces opened is generated once its first conversation completes', async () => {
  workspace('ws-a', 'Workspace A');
  const model = new FakeModel();
  const sched = scheduler(model);
  model.script = () => (current) => { writesHome(current, 'new'); };
  try {
    startSpacesFirstRun(sched, OWNER, now);
    assert.equal(getFirstRun('ws-a', OWNER)?.state, 'done');
    workspace('ws-new', 'New workspace', now);
    now += 61_000; await sched.tick(); await until(() => idle(sched));
    assert.equal(getFirstRun('ws-new', OWNER), null, 'an empty new workspace waits for a conversation');
    getDb().prepare("INSERT INTO nodes(id,workspace_id,kind,status,title,created_at) VALUES('node-running','ws-new','chat','idle','Still running',?)").run(now);
    beginTurn(createDurableTurn({ turnId: 'turn-running', assistantId: 'assistant-running', nodeId: 'node-running', workspaceId: 'ws-new',
      displayUserText: 'Working on it', startedAt: now }));
    now += 1_000; await sched.tick();
    assert.equal(getFirstRun('ws-new', OWNER), null, 'a conversation still running is not yet a finished one');
    conversation('ws-new', 'First chat', now);
    now += 1_000;
    await sched.tick();
    assert.equal(getFirstRun('ws-new', OWNER)?.state, 'queued');
    now += 61_000; await sched.tick();
    await until(() => getFirstRun('ws-new', OWNER)?.state === 'done' && idle(sched), 'new workspace home', sched);
    assert.equal(model.started.at(-1)?.job.workspaceId, 'ws-new');
  } finally {
    await sched.stop();
  }
});

test('the first read covers the range from the settings, fixed when the run is queued', async () => {
  updateMetaAgentSettings({ firstRunDays: 7 });
  workspace('ws-a', 'Workspace A');
  conversation('ws-a', 'Recent', now - 2 * DAY);
  conversation('ws-a', 'Two weeks ago', now - 14 * DAY);
  const model = new FakeModel();
  const sched = scheduler(model);
  let listed: string[] = [];
  model.script = (run) => (current) => {
    assert.match(run.job.prompt, /1 conversations with activity in the 7 days/);
    listed = current.call('list_threads', {}).conversations.map((entry: { title: string }) => entry.title);
    writesHome(current, 'A');
  };
  try {
    startSpacesFirstRun(sched, OWNER, now);
    assert.equal(getFirstRun('ws-a', OWNER)?.total, 1);
    updateMetaAgentSettings({ firstRunDays: 90 });
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'done' && idle(sched), 'first run', sched);
    assert.deepEqual(listed, ['Recent'], 'a change after queueing applies to later first reads');
  } finally {
    await sched.stop();
  }
});

test('with workspace homes off, background runs leave the homes alone until writing is on again', async () => {
  updateMetaAgentSettings({ writeWorkspaceHomes: false, maintainSpacesHome: false });
  workspace('ws-a', 'Workspace A');
  conversation('ws-a', 'Older', now - DAY);
  const model = new FakeModel();
  const sched = scheduler(model);
  const offered: string[][] = [];
  model.script = (run) => (current) => {
    if (/First-time/.test(run.job.prompt)) { writesHome(current, 'A'); return; }
    for (const source of run.hooks.maintenanceContext?.sources ?? []) {
      const { sourceTurnId } = source;
      const parts = current.call<{ parts: Array<{ partId: string; partHash: string }> }>('maintenance_read_source', { sourceTurnId }).parts;
      current.call('maintenance_read_source', { sourceTurnId, acknowledgeParts: parts.map(({ partId, partHash }) => ({ partId, partHash })) });
      offered.push(current.call<{ resources: Array<{ id: string }> }>('maintenance_list_resources', { sourceTurnId }).resources.map((resource) => resource.id));
      current.call('maintenance_route_source', { sourceTurnId, candidates: [], reason: 'Nothing to record' });
    }
  };
  try {
    startSpacesFirstRun(sched, OWNER, now);
    const home = homeOf('ws-a');
    assert.equal(getMaintenanceConfig('ws-a', OWNER)?.enabled, true, 'the workspace is still maintained');
    assert.equal(getFirstRun('ws-a', OWNER), null, 'no first read is queued');
    conversation('ws-a', 'New work', now);
    now += 61_000; await sched.tick();
    await until(() => model.started.length === 1 && idle(sched), 'an incremental run', sched);
    assert.equal(offered.length, 1);
    assert.equal(offered[0].includes(home), false, 'the home is not offered for routing');

    updateMetaAgentSettings({ writeWorkspaceHomes: true });
    startSpacesFirstRun(sched, OWNER, now);
    assert.equal(getFirstRun('ws-a', OWNER)?.total, 2, 'the first read is queued over a fresh range');
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'done' && idle(sched), 'the first read', sched);
    conversation('ws-a', 'Later work', now);
    now += 61_000; await sched.tick();
    await until(() => offered.length === 2 && idle(sched), 'the next incremental run', sched);
    assert.equal(offered.at(-1)!.includes(home), true, 'with writing on the home is offered again');
  } finally {
    await sched.stop();
  }
});

test('with the Spaces Home off, no summary runs until it is on again', async () => {
  updateMetaAgentSettings({ maintainSpacesHome: false });
  workspace('ws-a', 'Workspace A');
  conversation('ws-a', 'One', now - DAY);
  const model = new FakeModel();
  const sched = scheduler(model);
  model.script = (run) => (current) => {
    if (/First-time/.test(run.job.prompt)) { writesHome(current, 'A'); return; }
    if (/Spaces Home summary/.test(run.job.prompt)) return writesSummary(current, now);
    assert.fail(`unexpected run: ${run.job.prompt.slice(0, 60)}`);
  };
  try {
    startSpacesFirstRun(sched, OWNER, now);
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'done' && idle(sched), 'first run', sched);
    now += 61_000; await sched.tick(); await until(() => idle(sched));
    assert.equal(model.started.length, 1, 'no summary session');
    assert.equal(spacesFirstRunStatus(OWNER, now).summary.state, 'waiting');

    updateMetaAgentSettings({ maintainSpacesHome: true });
    assert.equal(spacesFirstRunStatus(OWNER, now).summary.state, 'due');
    now += 61_000; await sched.tick();
    await until(() => spacesFirstRunStatus(OWNER, now).summary.state === 'done' && idle(sched), 'the summary', sched);
    assert.equal(model.started.length, 2);
  } finally {
    await sched.stop();
  }
});

const CLOSING = (nodeId: string) => `Summary written.\n\`\`\`json\n${JSON.stringify({
  greeting: { text: 'Good morning.', detail: null },
  sets: [],
  firstRun: {
    wrote: 'I wrote 2 workspace homes and the global part of the Spaces Home.',
    lookFirst: 'Start with [Workspace A](michi://page/pg-x): its release waits on you.',
    question: 'Workspace B has not moved for two weeks: still waiting for review, or dropped?',
    options: ['Still waiting for review', 'Dropped, archive it', 'Dropped, archive it'],
    continueIn: { nodeId, label: 'Ask in that conversation', draft: 'Is the review still pending?' },
  },
})}\n\`\`\``;

test('the window conversation hears the first run: what it reads, each home, then what it wrote and one question', async () => {
  workspace('ws-a', 'Workspace A'); workspace('ws-b', 'Workspace B');
  conversation('ws-a', 'Release', now - 3_600_000); conversation('ws-a', 'Bug bash', now - 2 * 3_600_000);
  const older = conversation('ws-b', 'Review', now - DAY);
  const model = new FakeModel();
  const sched = scheduler(model);
  const summaryPrompts: string[] = [];
  model.script = (run) => (current) => {
    if (/First-time/.test(run.job.prompt)) { writesHome(current, run.job.workspaceId === 'ws-a' ? 'A ships Friday' : 'B waits for review'); return; }
    summaryPrompts.push(run.job.prompt);
    writesSummary(current, now);
    return { reply: CLOSING(older) };
  };
  try {
    startSpacesFirstRun(sched, OWNER, now);
    const [start] = windowNarration();
    assert.equal(start?.kind, 'start');
    assert.match(start!.text, /last 30 days of history, 3 conversations in 2 workspaces/);
    assert.match(start!.text, /The first time, I read each past conversation once\. After that I check every 60 seconds/);
    assert.doesNotMatch(start!.text, /list_threads|read_node|read_conversation_updates/);

    await until(() => getFirstRun('ws-b', OWNER)?.state === 'done' && idle(sched), 'both homes', sched);
    assert.deepEqual(windowNarration().slice(1).map((line) => line.text), [
      `[Workspace A](michi://page/${homeOf('ws-a')}) home is written: A ships Friday: 2 conversations`,
      `[Workspace B](michi://page/${homeOf('ws-b')}) home is written: B waits for review: 1 conversations`,
    ]);

    now += 61_000; await sched.tick();
    await until(() => spacesFirstRunStatus(OWNER, now).summary.state === 'done' && idle(sched), 'the summary', sched);
    assert.match(summaryPrompts[0]!, /This summary closes the first-time generation/);
    const end = windowNarration().at(-1)!;
    assert.equal(end.kind, 'end');
    assert.equal(end.text, 'I wrote 2 workspace homes and the global part of the Spaces Home. Start with [Workspace A](michi://page/pg-x): its release waits on you.'
      + '\n\nWorkspace B has not moved for two weeks: still waiting for review, or dropped?');
    assert.deepEqual(end.options, [
      { label: 'Still waiting for review' }, { label: 'Dropped, archive it' },
      { label: 'Ask in that conversation', open: { nodeId: older, workspaceId: 'ws-b', draft: 'Is the review still pending?' } },
    ]);
    const node = getDb().prepare('SELECT follow_ups, follow_ups_source_message_id FROM nodes WHERE id=?')
      .get(ensureAssistant().nodeId) as { follow_ups: string; follow_ups_source_message_id: string };
    assert.deepEqual(JSON.parse(node.follow_ups), ['Still waiting for review', 'Dropped, archive it', 'Ask in that conversation']);
    assert.equal(node.follow_ups_source_message_id, end.id);

    // Later visits and later summaries add nothing to the conversation.
    startSpacesFirstRun(sched, OWNER, now);
    const homeB = homeOf('ws-b');
    const blocks = getPage(homeB, OWNER).blocks;
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify([...blocks, { id: 'block-agent', type: 'markdown', text: 'B shipped', rev: 9,
      sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] }]), homeB);
    now += 61_000; await sched.tick();
    await until(() => summaryPrompts.length === 2 && idle(sched), 'second summary', sched);
    assert.doesNotMatch(summaryPrompts[1]!, /closes the first-time generation/);
    assert.equal(windowNarration().length, 4);
  } finally {
    await sched.stop();
  }
});

test('after the first run closed, a workspace home change runs an ordinary summary: the status says so and window edits go ahead', async () => {
  workspace('ws-a', 'Workspace A');
  conversation('ws-a', 'Release', now - 3_600_000);
  const model = new FakeModel();
  const sched = scheduler(model);
  const during: Array<{ closed: boolean | undefined; state: string; held: string | null }> = [];
  model.script = (run) => (current) => {
    if (/First-time/.test(run.job.prompt)) { writesHome(current, 'A'); return; }
    const status = spacesFirstRunStatus(OWNER, now);
    during.push({ closed: status.closed, state: status.summary.state, held: holdWindowPageWrite(null, null) });
    return writesSummary(current, now);
  };
  try {
    assert.equal(spacesFirstRunStatus(OWNER, now).closed, false, 'never opened');
    startSpacesFirstRun(sched, OWNER, now);
    assert.equal(spacesFirstRunStatus(OWNER, now).closed, false);
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'done' && idle(sched), 'the home', sched);
    now += 61_000; await sched.tick();
    await until(() => spacesFirstRunStatus(OWNER, now).summary.state === 'done' && idle(sched), 'the closing summary', sched);
    assert.equal(during[0]!.closed, false, 'the summary that closes the first run is still the first run');
    assert.match(during[0]!.held ?? '', /^HELD: the Meta agent's first-time generation is still writing/);
    assert.equal(spacesFirstRunStatus(OWNER, now).closed, true);

    const homeA = homeOf('ws-a');
    const blocks = getPage(homeA, OWNER).blocks;
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify([...blocks, { id: 'block-agent', type: 'markdown', text: 'A shipped', rev: 9,
      sources: [{ nodeId: 'n', turnId: 't', assistantId: 'a' }] }]), homeA);
    const due = spacesFirstRunStatus(OWNER, now);
    assert.deepEqual([due.summary.state, due.closed], ['due', true]);
    assert.equal(holdWindowPageWrite(null, { turnId: 'turn-later', assistantId: 'a-later' }), null);
    assert.doesNotMatch(firstRunTurnNote(), /still writing/);

    now += 61_000; await sched.tick();
    await until(() => during.length === 2 && idle(sched), 'the later summary', sched);
    assert.deepEqual(during[1], { closed: true, state: 'running', held: null });
    assert.deepEqual([spacesFirstRunStatus(OWNER, now).summary.state, spacesFirstRunStatus(OWNER, now).closed], ['done', true]);

    // Undoing that change brings back homes an earlier summary read; the page now says what the undone block said, so it runs again.
    getDb().prepare('UPDATE pages SET blocks=? WHERE id=?').run(JSON.stringify(blocks), homeA);
    assert.equal(spacesFirstRunStatus(OWNER, now).summary.state, 'due');
    now += 61_000; await sched.tick();
    await until(() => during.length === 3 && idle(sched), 'the summary after the undo', sched);
    assert.equal(spacesFirstRunStatus(OWNER, now).summary.state, 'done');
  } finally {
    await sched.stop();
  }
});

test('the closing message keeps only options that hold', () => {
  workspace('ws-a', 'Workspace A');
  const node = conversation('ws-a', 'Release', now - 3_600_000);
  const reply = (firstRun: unknown) => `\`\`\`json\n${JSON.stringify({ sets: [], firstRun })}\n\`\`\``;
  assert.deepEqual(parseFirstRunEnd(reply({ wrote: 'Wrote it.', question: 'Which?', options: [] }), OWNER),
    { text: 'Wrote it.', options: [] }, 'a question without options is not asked');
  const parsed = parseFirstRunEnd(reply({ wrote: 'Wrote it.', question: 'Keep it?', options: ['Yes', 'No', 'Later', 'Never'],
    continueIn: { nodeId: 'node-missing', label: 'Ask there', draft: 'x' } }), OWNER);
  assert.deepEqual(parsed?.options.map((option) => option.label), ['Yes', 'No', 'Later'], 'an unknown conversation is dropped, three options at most');
  const opened = parseFirstRunEnd(reply({ wrote: 'Wrote it.', question: 'Keep it?', options: ['Yes', 'No', 'Later'],
    continueIn: { nodeId: node, label: 'Ask there', draft: 'Still on?' } }), OWNER);
  assert.deepEqual(opened?.options.map((option) => option.label), ['Yes', 'No', 'Ask there']);
  assert.equal(parseFirstRunEnd('no json here', OWNER), null);
});

test('while the first run writes, window page changes wait for it and come back as one turn afterwards', async () => {
  updateMetaAgentSettings({ maintainSpacesHome: false });
  workspace('ws-a', 'Workspace A');
  conversation('ws-a', 'Release', now - 3_600_000);
  const model = new FakeModel();
  const sched = scheduler(model);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  model.script = () => async (current) => {
    current.call('list_threads', {});
    await hold;
    writesHome(current, 'A');
  };
  const assistant = ensureAssistant();
  const ctx = (turn: string) => ({ ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId,
    approveThreadMessage: async () => ({ approved: false as const, reason: 'declined' as const }),
    getActivePageTurnAttribution: () => ({ turnId: `turn-${turn}`, assistantId: `a-${turn}` }) });
  const tool = (name: string) => ASSISTANT_TOOLS.find((entry) => entry.name === name)!;
  try {
    startSpacesFirstRun(sched, OWNER, now);
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'reading', 'the first run reading', sched);
    saveMessage({ id: 'u-a-w1', node_id: assistant.nodeId, role: 'user', content: 'Add a risks section to Workspace A', seq: 50, created_at: now });
    const held = await tool('edit_page').execute(ctx('w1'), { pageId: homeOf('ws-a'), revision: 1, ops: [] });
    assert.equal(held.isError, true);
    assert.match(held.content[0]!.text, /^HELD: the Meta agent's first-time generation is still writing \(0 of 1 workspace homes written/);
    assert.match(held.content[0]!.text, /will make this change after the first run/);
    const read = await tool('read_page').execute(ctx('w1'), { pageId: homeOf('ws-a') });
    assert.doesNotMatch(read.content[0]!.text, /HELD/, 'reading goes ahead');
    assert.match(withMetaAgentContext('Why is B stalled?', { pageId: null }),
      /Your first-time generation is still writing: 0 of 1 workspace homes written[\s\S]*\n\nWhy is B stalled\?$/);

    const started: StartRequestedSelfTurnArgs[] = [];
    let finishTurn!: () => void;
    const turnDone = new Promise<void>((resolve) => { finishTurn = resolve; });
    const deps: ThreadMessagingDeps = {
      ensureSession: async (input) => ({ id: `chat-${input.nodeId}`, runtimeId: 'pi' }) as unknown as AgentSession,
      startTurn: async (args): Promise<StartedRequestedSelfTurn> => {
        started.push(args);
        return { turnId: args.turnId, assistantId: `self-${args.turnId}`, done: turnDone, existing: false };
      },
      acquireRestoreLock: async () => () => {},
      newTurnId: () => 'unused',
      startWaitMs: 50,
    };
    configureThreadMessaging(deps);

    release();
    await until(() => getFirstRun('ws-a', OWNER)?.state === 'done' && idle(sched) && started.length === 1, 'the first run and the held turn', sched);
    assert.equal(holdWindowPageWrite(null, { turnId: 'turn-w2', assistantId: 'a-w2' }), null, 'nothing is held once it closed');
    assert.equal(started[0]!.nodeId, assistant.nodeId);
    assert.match(started[0]!.turnId, /^mfr-held-\d+$/);
    assert.match(started[0]!.text, /held until now[\s\S]*1\. > Add a risks section to Workspace A/);
    assert.deepEqual(windowNarration().map((entry) => entry.kind), ['start', 'workspace', 'notice'], 'the closing message waits for the held turn');
    assert.match(windowNarration().at(-1)!.text, /^The first run is done\. Now making the page change you asked for while I was writing\.$/);
    assert.equal(await resumeHeldEdits(OWNER, deps), false, 'handed back once');

    finishTurn();
    await until(() => windowNarration().at(-1)?.kind === 'end', 'the closing message');
    assert.match(windowNarration().at(-1)!.text, /^Done: I read 1 conversation and wrote 1 workspace home\./);
    assert.match(firstRunTurnNote(), /Michi posted these messages in this conversation as you[\s\S]*> Done: I read 1 conversation/);

    saveMessage({ id: 'u-later', node_id: assistant.nodeId, role: 'user', content: 'Thanks', seq: 99, created_at: now });
    assert.equal(firstRunTurnNote(), '', 'what came before the next reply is no longer news');
  } finally {
    configureThreadMessaging(null);
    release();
    await sched.stop();
  }
});
