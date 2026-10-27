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
import { closeDb, getDb, initDb } from '../src/services/db';
import { updateAgentConfig } from '../src/services/agentConfig';
import { PageMaintenanceConfigService } from '../src/services/pages/maintenanceConfig';
import { createMaintenanceConfig, getMaintenanceConfig } from '../src/services/pages/maintenanceRepository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobScheduler, type ScheduledJobExecutor } from '../src/services/scheduledJobs/scheduler';
import { metaAgentOverview, setMetaAgentPaused, startOfLocalDay } from '../src/services/metaAgent/overview';
import { metaAgentUsageToday } from '../src/services/metaAgent/todayUsage';
import { setFirstRunWindowDays } from '../src/services/metaAgent/firstRunHistory';
import { setupMetaAgentOverviewRoutes } from '../src/routes/metaAgentOverview';
import { recordMetaAgentGuardCheck } from '../src/services/metaAgent/guardStatus';
import { resolveMetaAgentRuntime } from '../src/services/metaAgent/settings';

const LOCAL = 'local-user';
const DAY = startOfLocalDay(new Date(2026, 9, 23, 12).getTime());
const at = (hour: number, minute = 0) => DAY + (hour * 60 + minute) * 60_000;
const HASH = 'a'.repeat(64);

let dir: string;
let priorDataDir: string | undefined;
let priorCloud: string | undefined;
let now: number;
let ids: number;

beforeEach(() => {
  priorDataDir = process.env.MICHI_DATA_DIR;
  priorCloud = process.env.MICHI_CLOUD;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-meta-agent-overview-'));
  process.env.MICHI_DATA_DIR = dir;
  delete process.env.MICHI_CLOUD;
  closeDb(); initDb();
  updateAgentConfig({ runtime: 'claude', modelByRuntime: { claude: 'claude-opus-5.5' }, reasoningByRuntime: { claude: 'high' } });
  now = at(10, 45);
  ids = 0;
});

afterEach(() => {
  closeDb();
  if (priorDataDir === undefined) delete process.env.MICHI_DATA_DIR; else process.env.MICHI_DATA_DIR = priorDataDir;
  if (priorCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = priorCloud;
  fs.rmSync(dir, { recursive: true, force: true });
});

function scheduler(): ScheduledJobScheduler {
  const executor: ScheduledJobExecutor = { start: async () => { throw new Error('not used'); } };
  return new ScheduledJobScheduler({ repository: new ScheduledJobsRepository(), executor,
    events: new ScheduledJobEventBus(() => now), workspaceExists: () => true, runtimeExists: () => true,
    clock: () => now, createId: () => `job-${++ids}` });
}

function workspace(id: string, name: string, owner = LOCAL, createdAt = ++ids): void {
  getDb().prepare('INSERT INTO workspaces(id,name,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, name, owner, createdAt, createdAt);
}

function counter(workspaceId: string, value: number): void {
  getDb().prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(`conversation_completion_seq:${workspaceId}`, String(value));
}

/** A workspace with managed maintenance whose cursor and counter are `cursor` and `count`. */
function maintained(jobs: ScheduledJobScheduler, id: string, name: string, cursor: number, count = cursor): string {
  workspace(id, name);
  counter(id, cursor);
  const { job } = new PageMaintenanceConfigService(jobs, () => now).enable({ workspaceId: id, ownerUserId: LOCAL });
  counter(id, count);
  return job.id;
}

/** Another owner's workspace and maintenance config, written directly. */
function foreign(id: string, owner: string): string {
  workspace(id, `${owner}-ws`, owner);
  const jobId = `job-${id}`;
  getDb().prepare(`INSERT INTO scheduled_jobs(id,owner_user_id,workspace_id,name,prompt,schedule,created_at,updated_at,conversation_cursor)
    VALUES(?,?,?,?,?,?,1,1,0)`).run(jobId, owner, id, 'Space maintenance', 'p', JSON.stringify({ kind: 'every', everySeconds: 60 }));
  createMaintenanceConfig({ workspaceId: id, ownerUserId: owner, jobId, now, enabled: true });
  return jobId;
}

function run(jobId: string, workspaceId: string, startedAt: number, status = 'succeeded', error: string | null = null): string {
  const id = `run-${++ids}`;
  getDb().prepare(`INSERT INTO scheduled_job_runs(id,job_id,workspace_id,trigger,status,started_at,finished_at,error,claimed_by)
    VALUES(?,?,?,'scheduled',?,?,?,?,'test')`).run(id, jobId, workspaceId, status, startedAt, startedAt + 500, error);
  return id;
}

/** The maintenance conversation a run opens when its model session starts, with that session's turn. */
function session(jobId: string, workspaceId: string, startedAt: number): void {
  const nodeId = `n-session-${++ids}`;
  getDb().prepare(`INSERT INTO nodes(id,workspace_id,kind,status,minimized,spawned_by_agent,created_at,maintenance_job_id)
    VALUES (?,?,'chat','idle',0,0,?,?)`).run(nodeId, workspaceId, startedAt, jobId);
  getDb().prepare(`INSERT INTO turns(turn_id,node_id,assistant_message_id,status,started_at,updated_at) VALUES (?,?,?,'completed',?,?)`)
    .run(`turn-${nodeId}`, nodeId, `a-${nodeId}`, startedAt, startedAt);
}

function page(id: string, workspaceId: string, title: string, owner = LOCAL): void {
  getDb().prepare(`INSERT INTO pages(id,owner_user_id,workspace_id,title,blocks,updated_at,created_at) VALUES(?,?,?,?,'[]',1,1)`)
    .run(id, owner, workspaceId, title);
}

function plan(input: {
  jobId: string; workspaceId: string; after: number; through: number; createdAt: number; state?: string; owner?: string;
  runId?: string | null; turns?: number; pages?: string[]; outcomes?: Array<'written' | 'proposed' | 'no_change'>;
}): string {
  const id = `plan-${++ids}`;
  const owner = input.owner ?? LOCAL;
  getDb().prepare(`INSERT INTO page_maintenance_plans(id,workspace_id,owner_user_id,job_id,run_id,config_revision,generation,after_seq,through_seq,state,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`).run(id, input.workspaceId, owner, input.jobId, input.runId ?? null, ids, input.after, input.through,
    input.state ?? 'terminal', input.createdAt, input.createdAt + 1000);
  const turns = input.turns ?? 0;
  for (let i = 0; i < turns; i++) {
    getDb().prepare(`INSERT INTO page_maintenance_sources(plan_id,source_turn_id,completion_seq,evidence_json,state,updated_at)
      VALUES(?,?,?,'{}','terminal',?)`).run(id, `${id}-t${i}`, input.after + i + 1, input.createdAt);
  }
  (input.pages ?? []).forEach((pageId, i) => {
    getDb().prepare(`INSERT INTO page_maintenance_resources(plan_id,source_turn_id,resource_kind,resource_id,observed_revision,generation,page_ids_json,state,receipt_key,updated_at)
      VALUES(?,?,'page',?,1,1,'[]','written',?,?)`).run(id, `${id}-t${i % turns}`, pageId, `${id}-res-${i}`, input.createdAt);
  });
  (input.outcomes ?? []).forEach((outcome, i) => {
    getDb().prepare(`INSERT INTO page_maintenance_receipts(receipt_key,plan_id,job_id,source_turn_id,resource_kind,resource_id,generation,payload_hash,
      payload_json,assigned_ids_json,result_json,outcome,execution_json,evidence_json,committed_at)
      VALUES(?,?,?,?,'page',?,1,?,'{}','{}','{}',?,'{}','{}',?)`).run(`${id}-rc-${i}`, id, input.jobId, `${id}-t0`, `res-${i}`, HASH, outcome,
      input.createdAt + 500);
  });
  return id;
}

function proposal(workspaceId: string, pageId: string, kind: string, state = 'pending', owner = LOCAL): void {
  const id = `chg-${++ids}`;
  getDb().prepare(`INSERT INTO page_changes(id,owner_user_id,workspace_id,page_id,target_key,target,batch_id,op,forward_json,inverse_json,base_rev,source,proposal_state,created_at)
    VALUES(?,?,?,?,?,'{}','b','update','{}','{}',1,?,?,?)`).run(id, owner, workspaceId, pageId, `t-${id}`, JSON.stringify({ kind }), state, now);
}

function firstRun(workspaceId: string, total: number, state: string, startedAt: number): void {
  getDb().prepare(`INSERT INTO page_first_runs(workspace_id,owner_user_id,started_at,start_seq,read_count,total,state,error,updated_at)
    VALUES(?,?,?,0,?,?,?,NULL,?)`).run(workspaceId, LOCAL, startedAt, state === 'done' ? total : 0, total, state, startedAt + 60_000);
}

describe('Meta agent overview', () => {
  test('usage today counts checks, model sessions (home runs included) and the tokens runtimes reported', () => {
    const jobs = scheduler();
    const rabbit = maintained(jobs, 'ws-r', 'rabbitholes', 10, 12);
    const desk = maintained(jobs, 'ws-d', 'agent-desk', 4);
    page('pg-home', 'ws-r', 'rabbitholes home');
    assert.deepEqual(metaAgentUsageToday(LOCAL, now), { checks: 0, modelCalls: 0, tokens: null });

    run(desk, 'ws-d', at(-2));
    session(desk, 'ws-d', at(-2));
    run(desk, 'ws-d', at(9, 0));
    plan({ jobId: rabbit, workspaceId: 'ws-r', after: 10, through: 12, createdAt: at(9, 5), turns: 2, runId: run(rabbit, 'ws-r', at(9, 5)) });
    session(rabbit, 'ws-r', at(9, 5));
    const homeRun = run(desk, 'ws-d', at(9, 10));
    getDb().prepare(`INSERT INTO meta_agent_home_runs(id,kind,owner_user_id,workspace_id,job_id,run_id,target_page_id,fingerprint,state,created_at,updated_at)
      VALUES('mhr-1','first-run',?,'ws-d',?,?,'pg-home',NULL,'written',?,?)`).run(LOCAL, desk, homeRun, at(9, 10), at(9, 12));
    session(desk, 'ws-d', at(9, 10));
    const node = (id: string, workspaceId: string, jobId: string | null) => getDb().prepare(`INSERT INTO nodes
      (id,workspace_id,kind,status,minimized,spawned_by_agent,created_at,maintenance_job_id) VALUES (?,?,'chat','idle',0,0,1,?)`).run(id, workspaceId, jobId);
    const reply = (id: string, nodeId: string, createdAt: number, usage: unknown) => getDb().prepare(`INSERT INTO messages
      (id,node_id,role,content,seq,created_at,metadata) VALUES (?,?,'assistant','ok',0,?,?)`).run(id, nodeId, createdAt, usage === undefined ? null : JSON.stringify({ usageSummary: usage }));
    node('n-claude', 'ws-r', rabbit);
    reply('m-claude', 'n-claude', at(9, 6), { contextUsagePercentage: 12, source: 'estimated' });
    assert.deepEqual(metaAgentUsageToday(LOCAL, now), { checks: 3, modelCalls: 2, tokens: null }, 'a runtime that reports no count leaves tokens unknown');

    node('n-codex', 'ws-d', desk);
    reply('m-codex', 'n-codex', at(9, 11), { totalTokens: 41_000 });
    node('n-pi', 'ws-d', desk);
    reply('m-pi', 'n-pi', at(9, 20), { inputTokens: 900, outputTokens: 100 });
    reply('m-old', 'n-pi', at(-2), { totalTokens: 5_000 });
    node('n-user', 'ws-d', null);
    reply('m-user', 'n-user', at(9, 30), { totalTokens: 7_000 });
    assert.deepEqual(metaAgentUsageToday(LOCAL, now), { checks: 3, modelCalls: 2, tokens: 42_000 },
      'yesterday and ordinary conversations are not counted');
    assert.equal(metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).today.modelCalls, 2);
  });

  test('a run that failed before its model session opened is no model call, whatever it had to read', () => {
    const jobs = scheduler();
    const rabbit = maintained(jobs, 'ws-r', 'rabbitholes', 10, 13);
    for (const [minute, through] of [[1, 11], [2, 12], [3, 13]] as const) {
      plan({ jobId: rabbit, workspaceId: 'ws-r', after: 10, through, createdAt: at(9, minute), state: 'processing', turns: through - 10,
        runId: run(rabbit, 'ws-r', at(9, minute), 'failed', 'No codex auth found') });
    }
    getDb().prepare(`INSERT INTO meta_agent_home_runs(id,kind,owner_user_id,workspace_id,job_id,run_id,target_page_id,fingerprint,state,created_at,updated_at)
      VALUES('mhr-f','first-run',?,'ws-r',?,?,'pg-none',NULL,'failed',?,?)`).run(LOCAL, rabbit, run(rabbit, 'ws-r', at(9, 4), 'failed', 'No codex auth found'), at(9, 4), at(9, 4));
    assert.deepEqual(metaAgentUsageToday(LOCAL, now), { checks: 4, modelCalls: 0, tokens: null });
    session(rabbit, 'ws-r', at(9, 5));
    assert.equal(metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).today.modelCalls, 1);
  });

  test('says nothing can run while scheduled jobs are off on this backend', () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-r', 'rabbitholes', 3);
    assert.equal(metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).notRunning, null);
    const prior = process.env.MICHI_SCHEDULED_JOBS;
    process.env.MICHI_SCHEDULED_JOBS = '0';
    try {
      const overview = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY });
      assert.deepEqual(overview.notRunning, { reason: 'scheduler-off', message: 'Scheduled jobs are off on this backend' });
      assert.equal(overview.state, 'running', 'the state still says what maintenance would do, for an older window');
    } finally {
      if (prior === undefined) delete process.env.MICHI_SCHEDULED_JOBS; else process.env.MICHI_SCHEDULED_JOBS = prior;
    }
  });

  test('a first run reports the range it was queued with', () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-r', 'rabbitholes', 3);
    maintained(jobs, 'ws-d', 'agent-desk', 3);
    firstRun('ws-r', 12, 'done', at(8));
    firstRun('ws-d', 40, 'reading', at(8));
    setFirstRunWindowDays('ws-r', LOCAL, 7);
    setFirstRunWindowDays('ws-d', LOCAL, 90);
    const first = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).recentRuns.find((row) => row.kind === 'first-run');
    assert.equal(first?.firstRunDays, 90);
  });
  test('each Spaces Home summary is a row: the workspace homes that changed before it and the blocks it rewrote', () => {
    const jobs = scheduler();
    const rabbit = maintained(jobs, 'ws-r', 'rabbitholes', 3);
    maintained(jobs, 'ws-d', 'agent-desk', 3);
    maintained(jobs, 'ws-n', 'sample-dashboard', 3);
    for (const [id, workspaceId] of [['home-r', 'ws-r'], ['home-d', 'ws-d'], ['home-n', 'ws-n']]) {
      page(id, workspaceId, `${workspaceId} home`);
      getDb().prepare("UPDATE pages SET role='workspace-home' WHERE id=?").run(id);
    }
    page('spaces-home', 'ws-r', 'Home');
    getDb().prepare("UPDATE pages SET role='spaces-home' WHERE id='spaces-home'").run();
    const change = (pageId: string, workspaceId: string, kind: string, createdAt: number) => getDb().prepare(`INSERT INTO page_changes
      (id,owner_user_id,workspace_id,page_id,target_key,target,batch_id,op,forward_json,inverse_json,base_rev,source,application_state,created_at)
      VALUES(?,?,?,?,?,'{}','b','update','{}','{}',1,?,'applied',?)`).run(`chg-${++ids}`, LOCAL, workspaceId, pageId, `t-${ids}`, JSON.stringify({ kind }), createdAt);
    const block = (block: Record<string, unknown>) => ({ after: { kind: 'block', exists: true, block: { id: `b-${++ids}`, rev: 2, ...block }, location: { after: null } } });
    const summary = (createdAt: number, state: string, status: string, result: unknown = null, error: string | null = null) => getDb().prepare(`INSERT INTO meta_agent_home_runs
      (id,kind,owner_user_id,workspace_id,job_id,run_id,target_page_id,fingerprint,state,result_json,error,created_at,updated_at)
      VALUES(?,'home-summary',?,'ws-r',?,?,'spaces-home','f',?,?,?,?,?)`).run(`mhr-${++ids}`, LOCAL, rabbit, run(rabbit, 'ws-r', createdAt, status), state,
      result === null ? null : JSON.stringify(result), error, createdAt, createdAt + 60_000);

    for (const [pageId, workspaceId] of [['home-r', 'ws-r'], ['home-d', 'ws-d'], ['home-n', 'ws-n']]) change(pageId, workspaceId, 'maintenance', at(9, 30));
    summary(at(9, 40), 'written', 'succeeded', { applied: [block({ type: 'callout', text: 'Lead' })], proposed: [] });
    change('home-r', 'ws-r', 'chat', at(10, 5));
    change('home-d', 'ws-d', 'maintenance', at(10, 6));
    change('home-n', 'ws-n', 'user', at(10, 7));
    change('spaces-home', 'ws-r', 'maintenance', at(10, 8));
    summary(at(10, 12), 'written', 'succeeded', { applied: [
      block({ type: 'checklist', title: '本周重点', items: [] }), block({ type: 'markdown', text: '#### 各 workspace\n\n| a |' }), block({ type: 'markdown', text: 'no heading' }),
    ], proposed: [] });
    summary(at(10, 20), 'failed', 'failed', null, 'Kiro reached its usage or rate limit');
    summary(at(10, 25), 'active', 'succeeded');
    summary(at(10, 30), 'active', 'running');

    const rows = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).recentRuns.filter((row) => row.kind === 'summary')
      .map(({ at: time, state, workspaceId, workspaceCount, changedHomes, rewroteBlocks, error, noModelCall }) =>
        ({ time, state, workspaceId, workspaceCount, changedHomes, rewroteBlocks, error, noModelCall }));
    assert.deepEqual(rows, [
      { time: at(10, 30), state: 'running', workspaceId: null, workspaceCount: 0, changedHomes: [], rewroteBlocks: [], error: undefined, noModelCall: false },
      { time: at(10, 20), state: 'failed', workspaceId: null, workspaceCount: 0, changedHomes: [], rewroteBlocks: [], error: 'Kiro reached its usage or rate limit', noModelCall: false },
      { time: at(10, 12), state: 'done', workspaceId: null, workspaceCount: 2, changedHomes: ['agent-desk', 'rabbitholes'], rewroteBlocks: ['本周重点', '各 workspace'], error: undefined, noModelCall: false },
      { time: at(9, 40), state: 'done', workspaceId: null, workspaceCount: 3, changedHomes: ['agent-desk', 'rabbitholes', 'sample-dashboard'], rewroteBlocks: [], error: undefined, noModelCall: false },
    ], 'a person\'s edit and the Spaces Home\'s own changes are not home changes; a record whose run ended undecided is no row');
  });

  test('cursors, today and recent runs come from the configs, plans, receipts and runs', () => {
    const jobs = scheduler();
    const rabbit = maintained(jobs, 'ws-r', 'rabbitholes', 1287, 1289);
    const desk = maintained(jobs, 'ws-d', 'agent-desk', 4010, 4012);
    const dash = maintained(jobs, 'ws-n', 'sample-dashboard', 233);
    page('pg-release', 'ws-r', 'Michi 0.9 release');
    page('pg-home', 'ws-r', 'rabbitholes home');

    // Yesterday: agent-desk read up to 4010; a check before midnight is not today's.
    plan({ jobId: desk, workspaceId: 'ws-d', after: 4000, through: 4010, createdAt: at(-3), turns: 3, outcomes: ['written'],
      runId: run(desk, 'ws-d', at(-3)) });
    getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=4010 WHERE workspace_id=?').run('ws-d');
    run(dash, 'ws-n', at(-1));
    // 10:41: three quiet checks; 10:42: rabbitholes reads two turns.
    for (const [jobId, ws] of [[rabbit, 'ws-r'], [desk, 'ws-d'], [dash, 'ws-n']]) run(jobId, ws, at(10, 41));
    plan({ jobId: rabbit, workspaceId: 'ws-r', after: 1287, through: 1289, createdAt: at(10, 42), turns: 2,
      pages: ['pg-release', 'pg-home'], outcomes: ['written', 'written', 'proposed'], runId: run(rabbit, 'ws-r', at(10, 42)) });
    session(rabbit, 'ws-r', at(10, 42));
    getDb().prepare('UPDATE page_maintenance_configs SET completion_cursor=1289 WHERE workspace_id=?').run('ws-r');
    firstRun('ws-r', 38, 'done', at(9, 30));
    firstRun('ws-d', 112, 'done', at(9, 30));
    proposal('ws-r', 'pg-release', 'maintenance');
    proposal('ws-r', 'pg-release', 'chat');
    proposal('ws-r', 'pg-home', 'maintenance', 'dismissed');

    const overview = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY });
    assert.equal(overview.state, 'running');
    assert.equal(overview.error, undefined);
    assert.deepEqual(overview.runtime, { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high', followsGlobal: true });
    assert.deepEqual(overview.today, { checks: 4, checksTruncated: false, modelCalls: 1, writes: 2, pendingProposals: 1 });
    assert.deepEqual(overview.cursors.map(({ workspaceName, cursor, unread, state }) => ({ workspaceName, cursor, unread, state })), [
      { workspaceName: 'rabbitholes', cursor: 1289, unread: 0, state: 'synced' },
      { workspaceName: 'agent-desk', cursor: 4010, unread: 2, state: 'next' },
      { workspaceName: 'sample-dashboard', cursor: 233, unread: 0, state: 'no-new' },
    ]);
    assert.equal(overview.cursors[0].lastRunAt, at(10, 42) + 1000);
    assert.equal(overview.cursors[2].lastRunAt, null);

    const [read, quiet, first, lastNight, older] = overview.recentRuns;
    assert.equal(overview.recentRuns.length, 5);
    assert.deepEqual({ ...read }, {
      at: at(10, 42), since: at(10, 42), workspaceId: 'ws-r', workspaceName: 'rabbitholes', workspaceCount: 1,
      after: 1287, through: 1289, turns: 2, routedPages: 2, routedPageTitles: ['Michi 0.9 release', 'rabbitholes home'],
      writes: 2, proposals: 1, cursorTo: 1289, noModelCall: false, kind: 'incremental', count: 1, state: 'done', nodeId: null,
    });
    assert.equal(quiet.noModelCall, true);
    assert.equal(quiet.count, 3);
    assert.equal(quiet.workspaceCount, 3);
    assert.equal(quiet.workspaceId, null);
    assert.equal(first.kind, 'first-run');
    assert.equal(first.turns, 150);
    assert.equal(first.workspaceCount, 2);
    assert.equal(first.state, 'done');
    assert.equal(first.firstRunDays, 30, 'runs queued before the range was a setting read 30 days');
    assert.deepEqual([...overview.managedJobIds!].sort(), [rabbit, desk, dash].sort());
    assert.equal(older.workspaceName, 'agent-desk');
    assert.equal(older.cursorTo, 4010);
    assert.equal(lastNight.at, at(-1) + 500);
  });

  test('a read names the maintenance conversation its run opened; merged, first-run and deleted ones name none', () => {
    const jobs = scheduler();
    const a = maintained(jobs, 'ws-a', 'A', 10, 12);
    const b = maintained(jobs, 'ws-b', 'B', 5);
    const conversation = (nodeId: string, workspaceId: string, jobId: string, runId: string, deleted = false) => {
      getDb().prepare(`INSERT INTO nodes(id,workspace_id,kind,status,minimized,spawned_by_agent,created_at,maintenance_job_id,deleted_at)
        VALUES (?,?,'chat','idle',0,0,1,?,?)`).run(nodeId, workspaceId, jobId, deleted ? 2 : null);
      getDb().prepare('UPDATE scheduled_job_runs SET node_id=? WHERE id=?').run(nodeId, runId);
    };
    const readRun = run(a, 'ws-a', at(9, 3));
    plan({ jobId: a, workspaceId: 'ws-a', after: 10, through: 11, createdAt: at(9, 3), turns: 1, runId: readRun });
    conversation('n-maint-a', 'ws-a', a, readRun);
    const goneRun = run(a, 'ws-a', at(9, 5));
    plan({ jobId: a, workspaceId: 'ws-a', after: 11, through: 12, createdAt: at(9, 5), turns: 1, runId: goneRun });
    conversation('n-maint-gone', 'ws-a', a, goneRun, true);
    // Two quiet plans whose runs opened a conversation still merge into one row that opens nothing.
    for (const [jobId, ws, minute] of [[a, 'ws-a', 7], [b, 'ws-b', 8]] as const) {
      const quietRun = run(jobId, ws, at(9, minute));
      plan({ jobId, workspaceId: ws, after: 12, through: 12, createdAt: at(9, minute), runId: quietRun });
      conversation(`n-quiet-${ws}`, ws, jobId, quietRun);
    }
    firstRun('ws-a', 3, 'done', at(8));

    const rows = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).recentRuns;
    assert.deepEqual(rows.map(({ kind, count, workspaceId, nodeId }) => ({ kind, count, workspaceId, nodeId })), [
      { kind: 'incremental', count: 2, workspaceId: null, nodeId: null },
      { kind: 'incremental', count: 1, workspaceId: 'ws-a', nodeId: null },
      { kind: 'incremental', count: 1, workspaceId: 'ws-a', nodeId: 'n-maint-a' },
      { kind: 'first-run', count: 1, workspaceId: 'ws-a', nodeId: null },
    ]);
  });

  test('consecutive quiet checks merge into one row; a read or a failure splits them', () => {
    const jobs = scheduler();
    const a = maintained(jobs, 'ws-a', 'A', 10, 12);
    const b = maintained(jobs, 'ws-b', 'B', 5);
    run(a, 'ws-a', at(9, 0)); run(b, 'ws-b', at(9, 1)); run(a, 'ws-a', at(9, 2));
    plan({ jobId: a, workspaceId: 'ws-a', after: 10, through: 11, createdAt: at(9, 3), turns: 1, runId: run(a, 'ws-a', at(9, 3)) });
    // A plan over turns nobody can read (scheduled-job output) is a quiet check too.
    plan({ jobId: a, workspaceId: 'ws-a', after: 11, through: 12, createdAt: at(9, 4), runId: run(a, 'ws-a', at(9, 4)) });
    run(b, 'ws-b', at(9, 5));
    run(b, 'ws-b', at(9, 6), 'failed', 'Claude is not signed in');
    run(a, 'ws-a', at(9, 7), 'failed', 'Claude is not signed in');
    run(b, 'ws-b', at(9, 8), 'cancelled');

    const rows = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).recentRuns;
    assert.deepEqual(rows.map(({ state, count, workspaceCount, noModelCall, turns }) => ({ state, count, workspaceCount, noModelCall, turns })), [
      { state: 'failed', count: 2, workspaceCount: 2, noModelCall: true, turns: 0 },
      { state: 'done', count: 2, workspaceCount: 2, noModelCall: true, turns: 0 },
      { state: 'done', count: 1, workspaceCount: 1, noModelCall: false, turns: 1 },
      { state: 'done', count: 3, workspaceCount: 2, noModelCall: true, turns: 0 },
    ]);
    assert.equal(rows[0].error, 'Claude is not signed in');
    assert.equal(rows[1].since, at(9, 4));
    assert.equal(rows[1].at, at(9, 5) + 500);
    assert.equal(rows[1].cursorTo, null);
    assert.equal(rows[3].since, at(9, 0) + 500);
  });

  test('unread is the counter minus the cursor; failures and attention mark a workspace as error', () => {
    const jobs = scheduler();
    const a = maintained(jobs, 'ws-a', 'A', 10, 15);
    maintained(jobs, 'ws-b', 'B', 7, 3);
    const c = maintained(jobs, 'ws-c', 'C', 4);
    getDb().prepare("UPDATE scheduled_jobs SET last_status='failed', last_error='Kiro is not signed in', auto_paused=1 WHERE id=?").run(a);
    const held = plan({ jobId: c, workspaceId: 'ws-c', after: 4, through: 4, createdAt: at(8), state: 'attention', turns: 1 });
    getDb().prepare("UPDATE page_maintenance_sources SET state='attention' WHERE plan_id=?").run(held);

    const cursors = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).cursors;
    assert.deepEqual(cursors.map(({ unread, state, error }) => ({ unread, state, error })), [
      { unread: 5, state: 'error', error: 'Kiro is not signed in' },
      { unread: 0, state: 'no-new', error: undefined },
      { unread: 0, state: 'error', error: '1 conversation turn needs attention' },
    ]);
  });

  test('a runtime the Meta agent cannot run on is an error with its reason', () => {
    const jobs = scheduler();
    maintained(jobs, 'ws-a', 'A', 1);
    updateAgentConfig({ runtime: 'crew' });
    const overview = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY });
    assert.equal(overview.state, 'error');
    assert.equal(overview.runtime.runtimeId, 'crew');
    assert.match(overview.error ?? '', /Crew/);
    assert.equal(overview.stopped?.reason, 'runtime-unsupported');
    assert.deepEqual(overview.stopped?.workspaceIds, []);
  });

  describe('stopped by errors', () => {
    const fail = (jobId: string, error: string, autoPaused = true) => getDb()
      .prepare('UPDATE scheduled_jobs SET last_status=\'failed\', last_error=?, auto_paused=?, consecutive_failures=? WHERE id=?')
      .run(autoPaused ? `${error}. Paused after 5 failed runs in a row.` : error, autoPaused ? 1 : 0, autoPaused ? 5 : 1, jobId);
    const overview = () => metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY });

    test('a job that stopped after repeated failures stops the Meta agent with a plain reason', () => {
      const jobs = scheduler();
      maintained(jobs, 'ws-a', 'A', 1);
      const b = maintained(jobs, 'ws-b', 'B', 2);
      fail(b, 'codex binary not found. Tried: /usr/local/bin/codex. Install with: npm install -g @openai/codex, or set CODEX_CLI_BIN');
      const result = overview();
      assert.equal(result.state, 'error');
      assert.equal(result.error, 'Codex is not installed on this computer');
      assert.deepEqual(result.stopped, {
        reason: 'runtime-missing', message: 'Codex is not installed on this computer', workspaceIds: ['ws-b'],
        detail: 'codex binary not found. Tried: /usr/local/bin/codex. Install with: npm install -g @openai/codex, or set CODEX_CLI_BIN',
      });
      assert.deepEqual(result.cursors[1].problem, { reason: 'runtime-missing', message: 'Codex is not installed on this computer', stopped: true });
      assert.equal(result.cursors[0].problem, undefined);
    });

    for (const [error, reason, message] of [
      ['No Codex auth found. Expected /h/.codex/auth.json. Run `codex login` to authenticate', 'signed-out', 'Codex is not signed in'],
      ['Claude AI usage limit reached|1761234567', 'quota', 'Claude reached its usage or rate limit'],
      ['A pending maintenance source is no longer readable; progress retained', 'needs-attention', 'A conversation in A could not be read'],
      ['The model returned an empty answer\n  at turn.ts:4', 'other', 'The model returned an empty answer'],
    ] as const) {
      test(`reason ${reason}`, () => {
        const jobs = scheduler();
        fail(maintained(jobs, 'ws-a', 'A', 1), error);
        assert.deepEqual({ reason: overview().stopped?.reason, message: overview().stopped?.message }, { reason, message });
      });
    }

    test('a failure that is still being retried keeps it running and marks only the workspace', () => {
      const jobs = scheduler();
      fail(maintained(jobs, 'ws-a', 'A', 1), 'Claude AI usage limit reached', false);
      const result = overview();
      assert.equal(result.state, 'running');
      assert.equal(result.stopped, null);
      assert.deepEqual(result.cursors[0].problem, { reason: 'quota', message: 'Claude reached its usage or rate limit', stopped: false });
    });

    test('a batch marked as needing attention stops it, with the reason the source was held for', () => {
      const jobs = scheduler();
      const a = maintained(jobs, 'ws-a', 'A', 4);
      const held = plan({ jobId: a, workspaceId: 'ws-a', after: 4, through: 6, createdAt: at(8), state: 'attention', turns: 2 });
      getDb().prepare("UPDATE page_maintenance_sources SET state='attention', terminal_reason='contentTooLarge: the turn is over 2 MB' WHERE plan_id=?").run(held);
      assert.deepEqual(overview().stopped, {
        reason: 'needs-attention', message: '2 conversations in A could not be read', workspaceIds: ['ws-a'], detail: 'contentTooLarge: the turn is over 2 MB',
      });
    });

    test('a failed restriction check stops it and names the runtime and its extra tools', () => {
      const jobs = scheduler();
      maintained(jobs, 'ws-a', 'A', 1);
      updateAgentConfig({ runtime: 'kiro' });
      recordMetaAgentGuardCheck({ toolset: 'maintenance', profile: resolveMetaAgentRuntime(LOCAL),
        failure: { runtimeId: 'kiro', unexpectedTools: ['fs_write', 'execute_bash'] }, ownerUserId: LOCAL, now });
      assert.deepEqual(overview().stopped, {
        reason: 'restriction-check', message: 'Kiro started with tools outside the Meta agent\'s list: fs_write, execute_bash', workspaceIds: [],
      });
    });

    test('paused by the user is not stopped: paused everywhere reads as paused, paused workspaces drop out', () => {
      const jobs = scheduler();
      const a = maintained(jobs, 'ws-a', 'A', 1);
      const b = maintained(jobs, 'ws-b', 'B', 1);
      fail(b, 'Claude AI usage limit reached');
      new PageMaintenanceConfigService(jobs, () => now).update({ workspaceId: 'ws-b', ownerUserId: LOCAL,
        expectedRevision: getMaintenanceConfig('ws-b', LOCAL)!.revision, now, paused: true });
      fail(b, 'Claude AI usage limit reached');
      assert.equal(overview().state, 'running', 'the stopped workspace is paused; the other one runs');
      setMetaAgentPaused({ scheduler: jobs, ownerUserId: LOCAL, paused: true, clock: () => now });
      fail(a, 'Claude AI usage limit reached');
      assert.equal(overview().state, 'paused');
      assert.equal(overview().stopped, null);
    });

    test('Retry (resume) restarts a job that stopped itself and clears the stopped state', () => {
      const jobs = scheduler();
      const a = maintained(jobs, 'ws-a', 'A', 1);
      fail(a, 'codex binary not found');
      assert.equal(jobs.getJob(a).autoPaused, true);
      const revision = getMaintenanceConfig('ws-a', LOCAL)!.revision;
      setMetaAgentPaused({ scheduler: jobs, ownerUserId: LOCAL, paused: false, clock: () => now });
      assert.equal(jobs.getJob(a).autoPaused, false);
      assert.equal(jobs.getJob(a).enabled, true);
      assert.notEqual(jobs.getJob(a).nextRunAt, null);
      assert.equal(getMaintenanceConfig('ws-a', LOCAL)!.revision, revision, 'the maintenance config is unchanged');
      const result = overview();
      assert.equal(result.state, 'running');
      assert.equal(result.cursors[0].problem?.stopped, false, 'the last error stays until a run succeeds');
    });
  });

  test('pause and resume change every workspace through the maintenance service', () => {
    const jobs = scheduler();
    const a = maintained(jobs, 'ws-a', 'A', 1);
    const b = maintained(jobs, 'ws-b', 'B', 2);
    setMetaAgentPaused({ scheduler: jobs, ownerUserId: LOCAL, paused: true, clock: () => now });
    for (const [ws, job] of [['ws-a', a], ['ws-b', b]]) {
      assert.equal(getMaintenanceConfig(ws, LOCAL)!.paused, true);
      assert.equal(jobs.getJob(job).enabled, false);
    }
    assert.equal(metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).state, 'paused');
    const revision = getMaintenanceConfig('ws-a', LOCAL)!.revision;
    setMetaAgentPaused({ scheduler: jobs, ownerUserId: LOCAL, paused: true, clock: () => now });
    assert.equal(getMaintenanceConfig('ws-a', LOCAL)!.revision, revision, 'pausing again changes nothing');

    setMetaAgentPaused({ scheduler: jobs, ownerUserId: LOCAL, paused: false, clock: () => now });
    assert.equal(getMaintenanceConfig('ws-b', LOCAL)!.paused, false);
    assert.equal(jobs.getJob(b).enabled, true);
    assert.equal(getMaintenanceConfig('ws-a', LOCAL)!.completionCursor, 1, 'the cursor is kept');
    assert.equal(metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).state, 'running');
  });

  test('another owner\'s workspaces, runs and proposals stay out', () => {
    const jobs = scheduler();
    const mine = maintained(jobs, 'ws-mine', 'Mine', 3);
    const theirs = foreign('ws-theirs', 'alice');
    page('pg-theirs', 'ws-theirs', 'Theirs', 'alice');
    run(theirs, 'ws-theirs', at(9));
    plan({ jobId: theirs, workspaceId: 'ws-theirs', after: 0, through: 1, createdAt: at(9, 1), turns: 1, owner: 'alice', outcomes: ['written'] });
    session(theirs, 'ws-theirs', at(9, 1));
    proposal('ws-theirs', 'pg-theirs', 'maintenance', 'pending', 'alice');
    run(mine, 'ws-mine', at(9, 2));

    const local = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY });
    assert.deepEqual(local.cursors.map((row) => row.workspaceId), ['ws-mine']);
    assert.deepEqual(local.today, { checks: 1, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 });
    assert.deepEqual(local.recentRuns.map((row) => row.workspaceId), ['ws-mine']);

    const alice = metaAgentOverview({ ownerUserId: 'alice', now, dayStart: DAY });
    assert.deepEqual(alice.cursors.map((row) => row.workspaceId), ['ws-theirs']);
    assert.deepEqual(alice.today, { checks: 1, checksTruncated: false, modelCalls: 1, writes: 1, pendingProposals: 1 });

    setMetaAgentPaused({ scheduler: jobs, ownerUserId: LOCAL, paused: true, clock: () => now });
    assert.equal(getMaintenanceConfig('ws-theirs', 'alice')!.paused, false);
  });

  test('pruned run history marks today\'s checks as a lower bound', () => {
    const jobs = scheduler();
    const a = maintained(jobs, 'ws-a', 'A', 1);
    for (let i = 0; i < 50; i++) run(a, 'ws-a', at(8) + i * 60_000);
    const today = metaAgentOverview({ ownerUserId: LOCAL, now, dayStart: DAY }).today;
    assert.equal(today.checks, 50);
    assert.equal(today.checksTruncated, true);
  });

  describe('routes', () => {
    let server: http.Server;
    let base: string;

    async function listen(withScheduler: ScheduledJobScheduler | null): Promise<void> {
      const app = express();
      app.use(express.json());
      app.use('/api', setupMetaAgentOverviewRoutes({ scheduler: withScheduler, clock: () => now }));
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

    test('GET answers the overview; pause and resume answer it after the change', async () => {
      const jobs = scheduler();
      maintained(jobs, 'ws-a', 'A', 1, 3);
      await listen(jobs);
      const read = await call('GET', '/api/meta-agent/overview');
      assert.equal(read.status, 200);
      assert.deepEqual(read.body, metaAgentOverview({ ownerUserId: LOCAL, now }));
      assert.equal(read.body.cursors[0].unread, 2);

      const paused = await call('POST', '/api/meta-agent/pause');
      assert.equal(paused.status, 200, JSON.stringify(paused.body));
      assert.equal(paused.body.state, 'paused');
      assert.equal((await call('POST', '/api/meta-agent/resume', {}, '{}')).body.state, 'running');
      assert.equal((await call('POST', '/api/meta-agent/pause', {}, '{"all":true}')).status, 400);
      assert.equal(getMaintenanceConfig('ws-a', LOCAL)!.paused, false);
    });

    test('pause needs the scheduler; every route is local-only', async () => {
      await listen(null);
      assert.equal((await call('GET', '/api/meta-agent/overview')).status, 200);
      assert.equal((await call('POST', '/api/meta-agent/pause')).status, 404);
      assert.equal((await call('GET', '/api/meta-agent/overview', { host: 'evil.example' })).status, 403);
      assert.equal((await call('POST', '/api/meta-agent/resume', { origin: 'https://evil.example' })).status, 403);
    });
  });
});
