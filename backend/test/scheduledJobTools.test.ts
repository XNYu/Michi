/**
 * Scheduled Job agent tools: workspace scoping from the session binding,
 * single-use approval for every change except pausing, refusal inside Agent
 * Runs and scheduled runs, and registration on chat MCP slots and Pi only.
 * Uses a real scheduler on a temp SQLite MICHI_DATA_DIR with a fake executor.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScheduledJobsChangedEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobScheduler, type ScheduledJobExecutor } from '../src/services/scheduledJobs/scheduler';
import {
  askUserScheduledJobApprover,
  scheduledJobTool,
  type ScheduledJobApprovalRequest,
  type ScheduledJobApprovalResult,
  type ScheduledJobToolCaller,
  type ScheduledJobToolDeps,
  type ScheduledJobToolName,
} from '../src/agents/scheduledJobTools';
import { CHAT_ONLY_BUILTIN_TOOLS, listEnabledBuiltinTools } from '../src/agents/builtinTools';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import { buildPiTools } from '../src/agents/pi/piTools';
import { buildPreamble } from '../src/agents/preamble';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { chatOwner, runOwner } from './helpers/owners';

const TOOL_NAMES: ScheduledJobToolName[] = [
  'list_scheduled_jobs', 'create_scheduled_job', 'update_scheduled_job', 'run_scheduled_job', 'delete_scheduled_job',
];

const NOW = Date.parse('2026-10-16T12:00:00Z');

function seedWorkspace(id: string, name = id): void {
  getDb().prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run(id, name);
}

/** Starts nothing real; records a graph node so run rows satisfy foreign keys. */
class FakeExecutor implements ScheduledJobExecutor {
  started = 0;
  async start(job: { workspaceId: string }) {
    this.started += 1;
    const index = this.started;
    getDb().prepare('INSERT INTO trees (id, workspace_id, root_node_id, last_active_at, created_at) VALUES (?, ?, ?, 1, 1)')
      .run(`tree-${index}`, job.workspaceId, `node-run-${index}`);
    getDb().prepare(`INSERT INTO nodes (id, workspace_id, tree_id, kind, status, minimized, created_at) VALUES (?, ?, ?, 'chat', 'idle', 0, 1)`)
      .run(`node-run-${index}`, job.workspaceId, `tree-${index}`);
    return {
      nodeId: `node-run-${index}`, treeId: `tree-${index}`, turnId: `turn-${index}`,
      done: new Promise<never>(() => {}),
      cancel: () => {},
    };
  }
}

function parse(result: { content: Array<{ text: string }>; isError?: true }): any {
  assert.equal(result.isError, undefined, `unexpected error: ${result.content[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

function errorText(result: { content: Array<{ text: string }>; isError?: true }): string {
  assert.equal(result.isError, true, 'expected an error result');
  return result.content[0].text;
}

describe('scheduled job agent tools', () => {
  let tmpDir: string;
  let scheduler: ScheduledJobScheduler;
  let executor: FakeExecutor;
  let changes: ScheduledJobsChangedEvent[];
  let deps: ScheduledJobToolDeps;
  let runningNodes: Set<string>;
  let asked: ScheduledJobApprovalRequest[];
  let answer: ScheduledJobApprovalResult;
  let nextId: number;

  const caller: ScheduledJobToolCaller = { ownerUserId: null, workspaceId: 'ws-a', nodeId: 'n-chat', isAgentRun: false };
  const approve = async (request: ScheduledJobApprovalRequest) => { asked.push(request); return answer; };
  const call = (name: ScheduledJobToolName, args: unknown, who: ScheduledJobToolCaller = caller) =>
    scheduledJobTool(name, who, args, approve, deps);

  const hourly = { name: 'Digest', prompt: 'Summarize overnight changes.', schedule: { kind: 'every', everySeconds: 3600 } };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-scheduled-tools-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    seedWorkspace('ws-a', 'Research');
    seedWorkspace('ws-b');
    executor = new FakeExecutor();
    const events = new ScheduledJobEventBus(() => NOW);
    changes = [];
    events.subscribe({ send: () => {}, sendChange: (event) => changes.push(event) });
    nextId = 0;
    scheduler = new ScheduledJobScheduler({
      repository: new ScheduledJobsRepository(),
      executor,
      events,
      workspaceExists: (id) => id === 'ws-a' || id === 'ws-b',
      runtimeExists: () => true,
      clock: () => NOW,
      instanceId: 'tools-test',
      createId: () => `job-${++nextId}`,
      pollIntervalMs: 60_000,
    });
    runningNodes = new Set();
    deps = {
      scheduler,
      isScheduledRunNode: (nodeId) => runningNodes.has(nodeId),
      workspaceName: (id) => (id === 'ws-a' ? 'Research' : id),
      clock: () => NOW,
      timeZone: () => 'Asia/Tokyo',
    };
    asked = [];
    answer = { approved: true };
  });

  afterEach(async () => {
    await scheduler.stop();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('create asks once with the saved values and defaults to trust', async () => {
    const result = parse(await call('create_scheduled_job', hourly));

    assert.equal(result.status, 'created');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, 'Create scheduled job “Digest”?');
    assert.equal(asked[0].approveLabel, 'Create');
    const lines = asked[0].lines.join('\n');
    assert.match(lines, /Workspace: Research/);
    assert.match(lines, /Schedule: Every 1 hour, first run Oct 16, 2026, 22:00 GMT\+9/);
    assert.match(lines, /Permissions: Trust: tools run without asking/);
    assert.match(lines, /Prompt: “Summarize overnight changes\.”/);
    const [job] = scheduler.listJobs();
    assert.equal(job.workspaceId, 'ws-a');
    assert.equal(job.permissionMode, 'trust');
    assert.deepEqual(changes.map((change) => change.change), ['created']);
  });

  test('the agent can choose the permission mode, and the card shows it', async () => {
    parse(await call('create_scheduled_job', { ...hourly, permissionMode: 'ask', sessionMode: 'persistent' }));
    assert.match(asked[0].lines.join('\n'), /Permissions: Ask: tool approvals wait for you/);
    assert.match(asked[0].lines.join('\n'), /Thread: one thread that every run continues/);
    assert.equal(scheduler.listJobs()[0].permissionMode, 'ask');
    assert.equal(scheduler.listJobs()[0].sessionMode, 'persistent');
  });

  test('the workspace always comes from the session, never from arguments', async () => {
    parse(await call('create_scheduled_job', { ...hourly, workspaceId: 'ws-b', runtimeId: 'pi', modelId: 'x' }));
    const [job] = scheduler.listJobs();
    assert.equal(job.workspaceId, 'ws-a');
    assert.equal(job.runtimeId, null);
    assert.equal(job.modelId, null);
  });

  test('a declined create saves nothing and tells the agent not to retry', async () => {
    answer = { approved: false, reason: 'declined', note: 'not hourly, daily' };
    const result = parse(await call('create_scheduled_job', hourly));
    assert.equal(result.status, 'declined');
    assert.equal(result.userNote, 'not hourly, daily');
    assert.match(result.next, /Do not retry unless the user asks/);
    assert.equal(scheduler.listJobs().length, 0);
    assert.equal(changes.length, 0);
  });

  test('invalid input is rejected before the user is asked', async () => {
    const text = errorText(await call('create_scheduled_job', { ...hourly, schedule: { kind: 'every', everySeconds: 10 } }));
    assert.match(text, /^INVALID_ARGUMENT: Interval must be at least 1 minute/);
    assert.equal(asked.length, 0);
  });

  test('accepts an ISO 8601 time for one-shot jobs', async () => {
    parse(await call('create_scheduled_job', { ...hourly, schedule: { kind: 'at', at: '2026-10-17T09:00:00+09:00' } }));
    const [job] = scheduler.listJobs();
    assert.deepEqual(job.schedule, { kind: 'at', at: Date.parse('2026-10-17T00:00:00Z') });
    assert.match(asked[0].lines.join('\n'), /Once at Oct 17, 2026, 09:00 GMT\+9/);
    assert.match(errorText(await call('create_scheduled_job', { ...hourly, schedule: { kind: 'at', at: 'tomorrow' } })),
      /schedule\.at must be an ISO 8601 date-time/);
  });

  test('list says when another Michi instance schedules the jobs', async () => {
    // Not started: this process holds no scheduler lease.
    const list = parse(await call('list_scheduled_jobs', {}));
    assert.match(list.note, /Another Michi instance/);
  });

  test('list shows only this workspace and details one job with its runs', async () => {
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const own = scheduler.createJob({ ...hourly, workspaceId: 'ws-a' });
    scheduler.createJob({ ...hourly, name: 'Other', workspaceId: 'ws-b' });

    const list = parse(await call('list_scheduled_jobs', {}));
    assert.equal(list.count, 1);
    assert.equal(list.jobs[0].jobId, own.id);
    assert.equal(list.jobs[0].state, 'active');
    assert.equal(list.jobs[0].scheduleText, 'Every 1 hour');
    assert.equal(list.jobs[0].nextRun.local, 'Oct 16, 2026, 22:00 GMT+9');
    assert.equal(list.jobs[0].prompt, undefined);
    assert.match(list.note, /only while Michi's backend is running/);

    await scheduler.runNow(own.id);
    const detail = parse(await call('list_scheduled_jobs', { jobId: own.id }));
    assert.equal(detail.job.prompt, 'Summarize overnight changes.');
    assert.equal(detail.recentRuns.length, 1);
    assert.equal(detail.recentRuns[0].trigger, 'manual');
    assert.equal(asked.length, 0, 'listing never asks');
  });

  test('another workspace’s job is reported as not found by every tool', async () => {
    const other = scheduler.createJob({ ...hourly, workspaceId: 'ws-b' });
    for (const name of ['update_scheduled_job', 'run_scheduled_job', 'delete_scheduled_job'] as const) {
      assert.match(errorText(await call(name, { jobId: other.id, name: 'x' })), /^NOT_FOUND/, name);
    }
    assert.match(errorText(await call('list_scheduled_jobs', { jobId: other.id })), /^NOT_FOUND/);
    assert.equal(asked.length, 0);
    assert.equal(scheduler.getJob(other.id).name, 'Digest');
  });

  test('pausing needs no approval; resuming and other edits do', async () => {
    const job = scheduler.createJob({ ...hourly, workspaceId: 'ws-a' });
    changes = [];

    const paused = parse(await call('update_scheduled_job', { jobId: job.id, enabled: false }));
    assert.equal(paused.status, 'paused');
    assert.equal(asked.length, 0);
    assert.equal(scheduler.getJob(job.id).enabled, false);

    const resumed = parse(await call('update_scheduled_job', { jobId: job.id, enabled: true, permissionMode: 'yolo' }));
    assert.equal(resumed.status, 'updated');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].approveLabel, 'Save changes');
    assert.match(asked[0].lines.join('\n'), /Turns the job back on/);
    assert.match(asked[0].lines.join('\n'), /Permissions → YOLO/);
    assert.equal(scheduler.getJob(job.id).permissionMode, 'yolo');
    assert.deepEqual(changes.map((change) => change.change), ['updated', 'updated']);
  });

  test('an edit that changes nothing does not ask', async () => {
    const job = scheduler.createJob({ ...hourly, workspaceId: 'ws-a' });
    const result = parse(await call('update_scheduled_job', { jobId: job.id, name: 'Digest' }));
    assert.equal(result.status, 'unchanged');
    assert.equal(asked.length, 0);
    assert.match(errorText(await call('update_scheduled_job', { jobId: job.id })), /pass at least one field/);
  });

  test('a declined edit leaves the job as it was', async () => {
    const job = scheduler.createJob({ ...hourly, workspaceId: 'ws-a' });
    answer = { approved: false, reason: 'no_answer' };
    const result = parse(await call('update_scheduled_job', { jobId: job.id, prompt: 'Something else' }));
    assert.equal(result.status, 'declined');
    assert.match(result.next, /did not answer/);
    assert.equal(scheduler.getJob(job.id).prompt, 'Summarize overnight changes.');
  });

  test('run now and delete each need approval', async () => {
    const job = scheduler.createJob({ ...hourly, workspaceId: 'ws-a' });

    answer = { approved: false, reason: 'declined' };
    parse(await call('run_scheduled_job', { jobId: job.id }));
    assert.equal(executor.started, 0);

    answer = { approved: true };
    const started = parse(await call('run_scheduled_job', { jobId: job.id }));
    assert.equal(started.status, 'started');
    assert.equal(executor.started, 1);
    assert.match(asked[1].lines.join('\n'), /Permissions: Trust/);
    assert.match(errorText(await call('run_scheduled_job', { jobId: job.id })), /^CONFLICT/);

    const deleted = parse(await call('delete_scheduled_job', { jobId: job.id }));
    assert.equal(deleted.status, 'deleted');
    assert.equal(asked.at(-1)?.approveLabel, 'Delete');
    assert.equal(scheduler.listJobs().length, 0);
  });

  test('refuses Agent Runs, unbound sessions and the turn of a scheduled run', async () => {
    const job = scheduler.createJob({ ...hourly, workspaceId: 'ws-a' });
    runningNodes.add('n-run');
    for (const name of TOOL_NAMES) {
      const args = { ...hourly, jobId: job.id };
      assert.match(errorText(await call(name, args, { ...caller, isAgentRun: true })), /^UNSUPPORTED: .*not Agent Runs/, name);
      assert.match(errorText(await call(name, args, { ...caller, nodeId: null })), /^SOURCE_UNAVAILABLE/, name);
      assert.match(errorText(await call(name, args, { ...caller, nodeId: 'n-run' })), /^UNSUPPORTED: .*inside a scheduled run/, name);
    }
    assert.equal(asked.length, 0);
    assert.equal(scheduler.listJobs().length, 1);
  });

  test('reports unavailable when scheduling is off', async () => {
    const result = await scheduledJobTool('list_scheduled_jobs', caller, {}, approve, null);
    assert.match(errorText(result), /^UNAVAILABLE/);
  });

  test('an approver that cannot ask fails closed', async () => {
    answer = { approved: false, reason: 'unavailable' };
    assert.match(errorText(await call('create_scheduled_job', hourly)), /^APPROVAL_UNAVAILABLE/);
    assert.equal(scheduler.listJobs().length, 0);
  });
});

describe('askUserScheduledJobApprover', () => {
  const request: ScheduledJobApprovalRequest = {
    toolName: 'create_scheduled_job', action: 'create', jobName: 'Digest',
    title: 'Create scheduled job “Digest”?', lines: ['Schedule: Every 1 hour', 'Permissions: Trust'], approveLabel: 'Create',
  };

  test('only the exact approve option approves; typed answers decline with a note', async () => {
    let question = '';
    const approver = (reply: string | null) => askUserScheduledJobApprover(async (questions) => {
      question = questions[0].question;
      assert.deepEqual(questions[0].options.map((option) => option.label), ['Create', 'Cancel']);
      return reply === null ? null : { [questions[0].question]: reply };
    });
    assert.deepEqual(await approver('Create')(request), { approved: true });
    assert.equal(question, 'Create scheduled job “Digest”?\nSchedule: Every 1 hour\nPermissions: Trust');
    assert.deepEqual(await approver('Cancel')(request), { approved: false, reason: 'declined' });
    assert.deepEqual(await approver('make it daily')(request), { approved: false, reason: 'declined', note: 'make it daily' });
    assert.deepEqual(await approver(null)(request), { approved: false, reason: 'no_answer' });
    assert.deepEqual(await askUserScheduledJobApprover(undefined)(request), { approved: false, reason: 'unavailable' });
  });
});

describe('scheduled job tool registration', () => {
  const previous = { cloud: process.env.MICHI_CLOUD, flag: process.env.MICHI_SCHEDULED_JOBS };
  afterEach(() => {
    if (previous.cloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previous.cloud;
    if (previous.flag === undefined) delete process.env.MICHI_SCHEDULED_JOBS; else process.env.MICHI_SCHEDULED_JOBS = previous.flag;
  });

  function callbacks() {
    return {
      onSpawnBranches: async () => [], onSaveArtifact: async () => ({}), onUpdateArtifact: async () => ({}),
      onShowImage: async () => ({}), onAskUser: async () => null,
    };
  }

  function mcpToolNames(owner?: unknown): string[] {
    const registry = new McpSlotRegistry();
    const slot = registry.create(`slot-${Math.random()}`, '/tmp', null, { ...callbacks(), ...(owner ? { owner } : {}) } as never);
    return Object.keys((buildMcpServerForSlot(slot) as any)._registeredTools);
  }

  function piToolNames(owner: unknown): string[] {
    configureRuntimeDeps({
      historyStore: { getNode: () => null, listMessages: () => [], getWorkspace: () => null, getWorkspaceInstructions: () => null, hasGrant: () => false, grantPermission: () => {} } as any,
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'x', modelByRuntime: {}, reasoningByRuntime: {} }), resolveModel: () => '', resolveReasoning: () => undefined } as any,
      dataDir: '/tmp/agent-runtime-test',
    });
    const Type: any = new Proxy({}, { get: () => () => ({}) });
    try {
      return buildPiTools({
        bridge: {} as any, cwd: '/tmp', parentChatId: 'p', workspaceId: 'ws-a', enableFollowUps: true,
        imageQuota: { usedBytes: 0, limitBytes: 1 } as any, seenPaths: new Set<string>(), Type, owner,
      } as any).map((tool: any) => tool.name);
    } finally {
      __resetRuntimeDeps();
    }
  }

  const preamble = () => buildPreamble({ enableFollowUps: false, cwd: '/tmp/x' });

  test('chat MCP slots get all five tools; Agent Run slots get none', () => {
    delete process.env.MICHI_CLOUD;
    delete process.env.MICHI_SCHEDULED_JOBS;
    const chat = mcpToolNames();
    for (const name of TOOL_NAMES) assert.ok(chat.includes(name), `${name} on chat slot`);
    const run = mcpToolNames(runOwner('run-1', 'attempt-1'));
    for (const name of TOOL_NAMES) assert.ok(!run.includes(name), `${name} must not be on a Run slot`);
  });

  test('Pi offers them to chat threads only', () => {
    delete process.env.MICHI_CLOUD;
    const chat = piToolNames(chatOwner('n-a'));
    for (const name of TOOL_NAMES) assert.ok(chat.includes(name), `${name} for Pi chat`);
    const run = piToolNames(runOwner('run-1', 'attempt-1'));
    for (const name of TOOL_NAMES) assert.ok(!run.includes(name), `${name} must not be offered to Pi Runs`);
  });

  test('the tools and their preamble line disappear when scheduling is off', () => {
    process.env.MICHI_SCHEDULED_JOBS = '0';
    const names = listEnabledBuiltinTools().map((tool) => tool.name as string);
    for (const name of TOOL_NAMES) assert.ok(!names.includes(name));
    assert.ok(!mcpToolNames().includes('create_scheduled_job'));
    assert.doesNotMatch(preamble(), /create_scheduled_job/);

    delete process.env.MICHI_SCHEDULED_JOBS;
    process.env.MICHI_CLOUD = '1';
    assert.ok(!listEnabledBuiltinTools().some((tool) => tool.name === 'create_scheduled_job'));

    delete process.env.MICHI_CLOUD;
    assert.match(preamble(), /create_scheduled_job/);
  });

  test('they are never offered as Agent capabilities', () => {
    for (const name of TOOL_NAMES) assert.ok(CHAT_ONLY_BUILTIN_TOOLS.has(name));
  });
});
