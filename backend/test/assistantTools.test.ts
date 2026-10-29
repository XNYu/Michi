/**
 * The assistant's MCP slot (the Meta agent's chat window): exactly its own
 * tools, cross-workspace reads for the assistant only, no sending into
 * existing conversations, and ordinary chat slots unchanged. Temp SQLite per
 * test; thread delivery is an injected fake.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initDb } from '../src/services/db';
import { saveMessage, saveNode, saveTree, saveWorkspace, setAiGlobalContext, type NodeRow } from '../src/services/dbRepository';
import { McpSlotRegistry, buildMcpServerForSlot, type McpSlot } from '../src/services/mcpServer';
import { configureThreadMessaging, type ThreadMessagingDeps } from '../src/agents/threadMessageTool';
import type { StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import { ensureAssistant, ensureAssistantFor } from '../src/assistant/store';
import {
  ASSISTANT_TOOL_NAMES, LAYOUT_RULES_TOOL, META_AGENT_CHAT_TOOL_NAMES, SCHEDULE_ASSISTANT_TOOL_NAMES, START_CONVERSATION_TOOL, TURN_METADATA_TOOL_NAMES,
} from '../src/assistant/policy';
import { PAGE_TOOL_NAMES } from '../src/agents/pageToolNames';
import { SCHEDULED_JOB_TOOL_NAMES, isScheduledJobToolName } from '../src/agents/scheduledJobToolNames';
import { configureScheduledJobTools } from '../src/agents/scheduledJobTools';
import { ScheduledJobNotFoundError } from '../src/services/scheduledJobs/scheduler';
import type { ScheduledJobDto } from 'michi-shared';
import { runOwner } from './helpers/owners';

function seedWorkspace(id: string): void {
  saveWorkspace({ id, name: `Project ${id}`, cwd: `/tmp/${id}`, created_at: 1, updated_at: 1, settings: null });
}

function seedChat(id: string, workspaceId: string, opts: { title?: string; bound?: boolean } = {}): void {
  const treeId = `t-${id}`;
  saveTree({ id: treeId, workspace_id: workspaceId, root_node_id: id, last_active_at: 1, created_at: 1 });
  const row: NodeRow = {
    id, workspace_id: workspaceId, tree_id: treeId, kind: 'chat', title: opts.title ?? `Title ${id}`,
    status: 'idle', minimized: 0, spawned_by_agent: 0,
    acp_session_id: opts.bound === false ? null : id, runtime_id: 'claude', created_at: 1,
  };
  saveNode(row);
}

type AskUser = NonNullable<McpSlot['onAskUser']>;

function slotFor(nodeId: string, workspaceId: string, extra: Record<string, unknown> = {}, onAskUser?: AskUser): McpSlot {
  return new McpSlotRegistry().create(nodeId, '/tmp', null, {
    onSpawnBranches: async () => [],
    onSaveArtifact: () => null,
    onUpdateArtifact: () => null,
    onShowImage: () => ({ error: 'unsupported in test' }),
    ...(onAskUser ? { onAskUser } : {}),
    ...extra,
  } as never, { nodeId, workspaceId });
}

/** A slot as an assistant-profile session creates it (Claude, Codex). */
function assistantSlotFor(nodeId: string, workspaceId: string, extra: Record<string, unknown> = {}, onAskUser?: AskUser): McpSlot {
  return slotFor(nodeId, workspaceId, {
    restricted: true,
    exposedToolNames: new Set(META_AGENT_CHAT_TOOL_NAMES),
    ...extra,
  }, onAskUser);
}

function tools(slot: McpSlot): Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> {
  return (buildMcpServerForSlot(slot) as any)._registeredTools;
}

async function call(slot: McpSlot, name: string, args: Record<string, unknown> = {}) {
  const tool = tools(slot)[name];
  assert.ok(tool, `${name} is registered`);
  const result = await tool.handler(args, {});
  return { text: result.content.map((part) => part.text).join(''), isError: result.isError === true };
}

interface Harness { deps: ThreadMessagingDeps; ensured: Array<{ workspaceId: string; nodeId: string }>; started: StartRequestedSelfTurnArgs[] }

function harness(): Harness {
  const ensured: Harness['ensured'] = [];
  const started: StartRequestedSelfTurnArgs[] = [];
  return {
    ensured,
    started,
    deps: {
      ensureSession: async (input) => { ensured.push(input); return { id: input.nodeId, runtimeId: 'claude' } as unknown as AgentSession; },
      startTurn: async (args): Promise<StartedRequestedSelfTurn> => {
        started.push(args);
        return { turnId: args.turnId, assistantId: `self-${args.turnId}`, done: Promise.resolve(), existing: false };
      },
      acquireRestoreLock: async () => () => {},
      newTurnId: () => 'turn-1',
      startWaitMs: 50,
    },
  };
}

describe('Michi assistant MCP tools', () => {
  let tmpDir: string;
  let assistant: ReturnType<typeof ensureAssistant>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-assistant-tools-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    // The whole catalog, Desk tools included; one test below turns Desk off.
    process.env.MICHI_DESK = '1';
    closeDb();
    initDb();
    seedWorkspace('ws-a');
    seedWorkspace('ws-b');
    seedChat('n-a1', 'ws-a', { title: 'Research notes' });
    seedChat('n-a2', 'ws-a', { title: 'Implementation' });
    seedChat('n-b1', 'ws-b', { title: 'Release checklist' });
    assistant = ensureAssistant();
  });

  afterEach(() => {
    configureThreadMessaging(null);
    configureScheduledJobTools(null);
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the assistant slot exposes exactly the chat-window toolset, without send_to_thread', () => {
    const chatTools = META_AGENT_CHAT_TOOL_NAMES.filter((name) => !(TURN_METADATA_TOOL_NAMES as readonly string[]).includes(name));
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId, {}, async () => null);
    assert.deepEqual(Object.keys(tools(slot)).sort(), [...chatTools].sort());
    assert.ok(!Object.keys(tools(slot)).includes('send_to_thread'));

    // Runtime callbacks cannot widen the assistant profile's tool allow-list.
    const withMetadata = assistantSlotFor(assistant.nodeId, assistant.workspaceId, {
      onSetFollowUps: () => {}, onSetBranchOverview: () => {}, onValidateFollowUps: () => ({}),
    }, async () => null);
    const names = Object.keys(tools(withMetadata));
    assert.deepEqual([...names].sort(), [...META_AGENT_CHAT_TOOL_NAMES].sort(), 'the whole catalog is the closed allow-list');
    assert.deepEqual(names.filter((n) => !(ASSISTANT_TOOL_NAMES as readonly string[]).includes(n)
      && !(PAGE_TOOL_NAMES as readonly string[]).includes(n)).sort(),
    ['ask_user', 'read_conversation_updates', LAYOUT_RULES_TOOL, START_CONVERSATION_TOOL].sort());
    for (const name of TURN_METADATA_TOOL_NAMES) assert.ok(!names.includes(name), `${name} belongs to ordinary chats`);
    assert.ok(!Object.keys(tools(assistantSlotFor(assistant.nodeId, assistant.workspaceId))).includes('ask_user'),
      'a slot without a question callback cannot advertise ask_user');
    for (const writer of ['save_artifact', 'update_artifact', 'spawn_branches', 'show_image', 'open_url', 'spawn_agent']) {
      assert.ok(!names.includes(writer), `${writer} is not offered to the assistant`);
    }
    assert.deepEqual(names.filter((name) => name.startsWith('desk_')), [], 'nothing reads or writes Agent Desk');
  });

  test('the assistant workspace retains its catalog without restricting native tools', () => {
    const channels = ['ask_user'];
    // A session not set up as the assistant (say, a runtime that ignored the profile) in its home: nothing but the channels.
    const unmarked = Object.keys(tools(slotFor(assistant.nodeId, assistant.workspaceId, {}, async () => null))).sort();
    assert.deepEqual(unmarked, [...META_AGENT_CHAT_TOOL_NAMES].sort());
    // An assistant-profile slot anywhere else: the same.
    const elsewhere = Object.keys(tools(assistantSlotFor('n-a1', 'ws-a', {}, async () => null))).sort();
    assert.deepEqual(elsewhere, channels);
    // An Agent Run owner never gets it, even bound to the assistant's node.
    const run = Object.keys(tools(assistantSlotFor(assistant.nodeId, assistant.workspaceId, {
      owner: runOwner('r-1', 'a-1'),
    }, async () => null)));
    assert.ok(!run.includes('list_workspaces') && !run.includes(START_CONVERSATION_TOOL));
  });

  test('ordinary chat slots keep their tools and never see the assistant ones', () => {
    const names = Object.keys(tools(slotFor('n-a1', 'ws-a', {}, async () => null)));
    for (const name of ['save_artifact', 'spawn_branches', 'show_image', 'list_threads', 'inspect_pane', 'send_to_thread', 'ask_user']) {
      assert.ok(names.includes(name), `${name} stays on chat slots`);
    }
    for (const name of ['list_workspaces', START_CONVERSATION_TOOL]) {
      assert.ok(!names.includes(name), `${name} is assistant-only`);
    }
    assert.deepEqual(names.filter((name) => name.startsWith('desk_')), []);
  });

  test('a slot that is not serving refuses every call, and serves again only when its session says so', async () => {
    let serving = false;
    let asked = 0;
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId, { isServing: () => serving }, async () => { asked += 1; return null; });
    assert.ok(Object.keys(tools(slot)).includes('list_workspaces'), 'listing is unaffected');
    for (const [name, args] of [['list_workspaces', {}], ['edit_page', { pageId: 'x', revision: 1, ops: [] }], ['ask_user', { questions: [] }]] as const) {
      const refused = await call(slot, name, args as Record<string, unknown>);
      assert.ok(refused.isError, name);
      assert.match(refused.text, /cannot run tools now/, name);
    }
    assert.equal(asked, 0);
    serving = true;
    const listed = await call(slot, 'list_workspaces');
    assert.equal(listed.isError, false);
    assert.ok(JSON.parse(listed.text));
  });

  test('scheduled-job tools are for ordinary chats: never the assistant, nor a fenced slot', () => {
    const scheduling = (slot: McpSlot) => Object.keys(tools(slot)).filter((name) => isScheduledJobToolName(name)).sort();
    assert.deepEqual(scheduling(slotFor('n-a1', 'ws-a', {}, async () => null)), [...SCHEDULED_JOB_TOOL_NAMES].sort(),
      'ordinary chats keep them');
    assert.deepEqual(scheduling(assistantSlotFor(assistant.nodeId, assistant.workspaceId, {}, async () => null)), [],
      'the assistant is not a worker');
    assert.deepEqual(scheduling(slotFor(assistant.nodeId, assistant.workspaceId, {}, async () => null)), [],
      "an unmarked session in the assistant's workspace");
    assert.deepEqual(scheduling(assistantSlotFor('n-a1', 'ws-a', {}, async () => null)), [],
      'an assistant-profile session elsewhere');
  });

  test('the Scheduled window\'s conversation gets its own catalog: conversation reads and scheduled jobs, no Pages', () => {
    const schedule = ensureAssistantFor('schedule');
    const names = Object.keys(tools(slotFor(schedule.nodeId, schedule.workspaceId, {}, async () => null))).sort();
    assert.deepEqual(names, [...SCHEDULE_ASSISTANT_TOOL_NAMES].sort());
    for (const name of [...PAGE_TOOL_NAMES, START_CONVERSATION_TOOL, LAYOUT_RULES_TOOL, 'send_to_thread', 'read_conversation_updates', 'save_artifact']) {
      assert.ok(!names.includes(name), `${name} is not the Scheduled window's`);
    }
    // The Spaces conversation in the same workspace keeps its own catalog, without scheduled jobs.
    const spaces = Object.keys(tools(slotFor(assistant.nodeId, assistant.workspaceId, {}, async () => null)));
    assert.deepEqual([...spaces].sort(), [...META_AGENT_CHAT_TOOL_NAMES].sort());
    assert.ok(!spaces.some((name) => isScheduledJobToolName(name)));
  });

  test('the Scheduled window schedules only where the user lets it, and the approval names the workspace', async () => {
    const jobs: ScheduledJobDto[] = [];
    configureScheduledJobTools({
      scheduler: {
        status: () => ({ active: true, serviceMode: true }),
        listJobs: () => jobs,
        getJob: (id: string) => { const job = jobs.find((each) => each.id === id); if (!job) throw new ScheduledJobNotFoundError('Scheduled job not found'); return job; },
        listRuns: () => [],
        requirePromptJob: () => {},
        validateCreate: (input: Record<string, unknown>) => ({
          name: input.name, prompt: input.prompt, schedule: input.schedule, permissionMode: 'trust', sessionMode: 'fresh',
          notify: true, enabled: true, timeoutSeconds: 1800,
        }),
        createJob: (input: Record<string, unknown>) => {
          const job = { id: `job-${jobs.length + 1}`, workspaceId: input.workspaceId, name: input.name, prompt: input.prompt, schedule: input.schedule,
            permissionMode: 'trust', sessionMode: 'fresh', notify: true, enabled: true, autoPaused: false, timeoutSeconds: 1800,
            nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, activeRunId: null, runtimeId: null, modelId: null } as unknown as ScheduledJobDto;
          jobs.push(job);
          return job;
        },
      } as never,
      isScheduledRunNode: () => false,
    });
    seedWorkspace('ws-arch');
    getDb().prepare('UPDATE workspaces SET archived_at = 9 WHERE id = ?').run('ws-arch');
    setAiGlobalContext('ws-b', false);
    const questions: string[] = [];
    const schedule = ensureAssistantFor('schedule');
    const slot = slotFor(schedule.nodeId, schedule.workspaceId, {}, async (qs) => { questions.push(qs[0].question); return { [qs[0].question]: 'Create' }; });
    const job = { name: 'Digest', prompt: 'Summarize overnight changes.', schedule: { kind: 'every', everySeconds: 3600 } };

    for (const [workspaceId, refusal] of [
      [schedule.workspaceId, /^INVALID_ARGUMENT: workspace not found/],
      ['ws-missing', /^INVALID_ARGUMENT: workspace not found/],
      ['ws-b', /^NAVIGATION_DISABLED: "Let AI navigate this workspace" is off in Project ws-b/],
      ['ws-arch', /^INVALID_ARGUMENT: Project ws-arch is archived/],
    ] as const) {
      const refused = await call(slot, 'create_scheduled_job', { ...job, workspaceId });
      assert.ok(refused.isError, workspaceId);
      assert.match(refused.text, refusal, workspaceId);
    }
    assert.equal(questions.length, 0, 'the user is asked only about a job that can be created');
    assert.equal(jobs.length, 0);

    const created = await call(slot, 'create_scheduled_job', { ...job, workspaceId: 'ws-a' });
    assert.equal(created.isError, false, created.text);
    assert.equal(JSON.parse(created.text).status, 'created');
    assert.equal(questions.length, 1);
    assert.match(questions[0], /^Create scheduled job “Digest”\?\nWorkspace: Project ws-a\n/);
    assert.equal(jobs[0].workspaceId, 'ws-a');
    assert.deepEqual(JSON.parse((await call(slot, 'list_scheduled_jobs')).text).jobs.map((each: any) => each.workspace), [{ id: 'ws-a', name: 'Project ws-a' }]);
  });

  test('ordinary chats still cannot message or inspect another workspace', async () => {
    const h = harness();
    configureThreadMessaging(h.deps);
    let asked = 0;
    const slot = slotFor('n-a1', 'ws-a', {}, async (questions) => { asked += 1; return { [questions[0].question]: 'Send' }; });
    const sent = await call(slot, 'send_to_thread', { nodeId: 'n-b1', text: 'hi' });
    assert.ok(sent.isError);
    assert.match(sent.text, /^NOT_FOUND/);
    assert.equal(asked, 0);
    assert.equal(h.started.length, 0);

    const inspected = await call(slot, 'inspect_pane', { nodeId: 'n-b1' });
    assert.ok(inspected.isError);
    assert.match(inspected.text, /NOT_FOUND/);

    // Same-workspace messaging is unchanged, header included.
    const local = await call(slot, 'send_to_thread', { nodeId: 'n-a2', text: 'hi' });
    assert.equal(JSON.parse(local.text).status, 'started');
    assert.match(h.started[0].text, /^\[Thread message\] From "Research notes"/);
    assert.equal(asked, 0, 'routine messages do not ask for approval');
  });

  test('the assistant cannot send into an existing conversation, even with send_to_thread allow-listed', async () => {
    const h = harness();
    configureThreadMessaging(h.deps);
    let asked = 0;
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId, {
      exposedToolNames: new Set([...META_AGENT_CHAT_TOOL_NAMES, 'send_to_thread']),
    }, async (qs) => { asked += 1; return { [qs[0].question]: 'Send' }; });
    assert.equal(tools(slot).send_to_thread, undefined);
    assert.equal(asked, 0);
    assert.equal(h.started.length, 0);
  });

  test('the assistant inspects and reads panes and nodes in any workspace', async () => {
    saveMessage({ id: 'm-b1', node_id: 'n-b1', role: 'assistant', content: 'Checklist is 3/5 done.', seq: 1, created_at: 2 });
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId);
    const inspected = await call(slot, 'inspect_pane', { nodeId: 'n-b1' });
    assert.ok(!inspected.isError, inspected.text);
    assert.match(inspected.text, /title: Release checklist/);

    const output = await call(slot, 'read_pane_output', { nodeId: 'n-b1' });
    assert.ok(!output.isError, output.text);

    const node = await call(slot, 'read_node', { nodeId: 'n-b1' });
    assert.match(node.text, /assistant \[message m-b1\]: Checklist is 3\/5 done/, 'each message carries the id a citation links to');
    const paged = await call(slot, 'read_node', { nodeId: 'n-b1', from: 'tail', limit: 1 });
    assert.match(paged.text, /assistant \[message m-b1\]: /);
    const overview = await call(slot, 'read_node_overview', { nodeId: 'n-b1' });
    assert.match(overview.text, /Release checklist/);

    const missing = await call(slot, 'inspect_pane', { nodeId: 'n-missing' });
    assert.match(missing.text, /NOT_FOUND/);
  });

  test('each workspace\'s "Let AI navigate this workspace" holds for the assistant too', async () => {
    const h = harness();
    configureThreadMessaging(h.deps);
    let asked = 0;
    saveMessage({ id: 'm-a1', node_id: 'n-a1', role: 'user', content: 'zebra migration plan', seq: 1, created_at: 1 });
    saveMessage({ id: 'm-b1', node_id: 'n-b1', role: 'user', content: 'zebra release notes', seq: 1, created_at: 1 });
    setAiGlobalContext('ws-b', false);
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId, {}, async (qs) => { asked += 1; return { [qs[0].question]: 'Send' }; });

    const listed = JSON.parse((await call(slot, 'list_workspaces')).text).workspaces as Array<{ id: string; aiNavigation: boolean }>;
    assert.deepEqual(Object.fromEntries(listed.map((w) => [w.id, w.aiNavigation])), { 'ws-a': true, 'ws-b': false });

    for (const [name, args] of [
      ['list_threads', { workspaceId: 'ws-b' }],
      ['read_node', { nodeId: 'n-b1' }],
      ['read_node_overview', { nodeId: 'n-b1' }],
      ['search_messages', { query: 'zebra', workspaceId: 'ws-b' }],
      ['inspect_pane', { nodeId: 'n-b1' }],
      ['read_pane_output', { nodeId: 'n-b1' }],
      ['wait_pane', { nodeId: 'n-b1', until: 'terminal', executionRef: { kind: 'chat_turn', nodeId: 'n-b1', turnId: 't-1' }, timeoutMs: 1 }],
      ['list_panes', { workspaceId: 'ws-b', scope: 'all' }],
    ] as const) {
      const refused = await call(slot, name, args);
      assert.ok(refused.isError, name);
      assert.match(refused.text, /Let AI navigate this workspace/, name);
      assert.doesNotMatch(refused.text, /zebra|Release checklist/, `${name} reveals nothing of the workspace`);
    }
    assert.equal(asked, 0, 'the user is not asked to approve a message that cannot be sent');
    assert.equal(h.started.length, 0);

    const all = await call(slot, 'search_messages', { query: 'zebra' });
    assert.match(all.text, /Found 1 match:/);
    assert.match(all.text, /node: n-a1/, 'a search across workspaces leaves ws-b out');
    assert.ok(!(await call(slot, 'read_node', { nodeId: 'n-a1' })).isError);

    setAiGlobalContext('ws-b', true);
    assert.ok(!(await call(slot, 'read_node', { nodeId: 'n-b1' })).isError, 'back on, readable again');
  });

  test('read_node and its overview refuse nodes in deleted or system workspaces', async () => {
    saveMessage({ id: 'm-q', node_id: assistant.nodeId, role: 'user', content: 'my question', seq: 1, created_at: 1 });
    getDb().prepare('UPDATE workspaces SET deleted_at = 5 WHERE id = ?').run('ws-a');
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId);
    for (const nodeId of ['n-a1', assistant.nodeId, 'n-missing']) {
      for (const name of ['read_node', 'read_node_overview']) {
        const refused = await call(slot, name, { nodeId });
        assert.ok(refused.isError, `${name} ${nodeId}`);
        assert.match(refused.text, new RegExp(`node not found: ${nodeId}`));
      }
    }
  });

  test('list_workspaces, list_threads and list_panes name the workspace explicitly', async () => {
    getDb().prepare('UPDATE trees SET archived_at = 9 WHERE id = ?').run('t-n-a2');
    saveWorkspace({ id: 'ws-gone', name: 'Gone', created_at: 1, updated_at: 1, deleted_at: 5 });
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId);

    const listed = JSON.parse((await call(slot, 'list_workspaces')).text).workspaces as Array<Record<string, unknown>>;
    assert.deepEqual(listed.map((w) => w.id).sort(), ['ws-a', 'ws-b'], 'hidden and deleted workspaces are left out');
    const a = listed.find((w) => w.id === 'ws-a')!;
    assert.equal(a.threads, 1);
    assert.equal(a.archivedThreads, 1);
    assert.equal(a.cwd, '/tmp/ws-a');

    assert.match((await call(slot, 'list_threads')).text, /^INVALID_ARGUMENT: workspaceId/);
    assert.match((await call(slot, 'list_threads', { workspaceId: assistant.workspaceId })).text, /workspace not found/);
    assert.match((await call(slot, 'list_threads', { workspaceId: 't-x' })).text, /thread or node id/);
    const unknown = await call(slot, 'list_threads', { workspaceId: 'p-x' });
    assert.match(unknown.text, /workspace not found/);
    assert.doesNotMatch(unknown.text, /thread or node id/);
    const threads = await call(slot, 'list_threads', { workspaceId: 'ws-a' });
    assert.ok(!threads.isError, threads.text);
    assert.match(threads.text, /n-a1/);

    assert.match((await call(slot, 'list_panes', { workspaceId: 't-x', scope: 'all' })).text, /thread or node id/);
    const noWorkspace = await call(slot, 'list_panes', { scope: 'all' });
    assert.ok(noWorkspace.isError);
    assert.match(noWorkspace.text, /workspaceId is required/);
    const panes = await call(slot, 'list_panes', { workspaceId: 'ws-b', scope: 'all' });
    assert.ok(!panes.isError, panes.text);
    assert.match(panes.text, /Release checklist/);
    assert.doesNotMatch(panes.text, /Research notes/);
  });

  test('search_messages covers every workspace or one', async () => {
    saveMessage({ id: 'm-a1', node_id: 'n-a1', role: 'user', content: 'zebra migration plan', seq: 1, created_at: 1 });
    saveMessage({ id: 'm-b1', node_id: 'n-b1', role: 'user', content: 'zebra release notes', seq: 1, created_at: 1 });
    saveMessage({ id: 'm-q', node_id: assistant.nodeId, role: 'user', content: 'where did I write about zebra?', seq: 1, created_at: 3 });
    saveWorkspace({ id: 'ws-gone', name: 'Gone', created_at: 1, updated_at: 1, settings: null });
    seedChat('n-gone', 'ws-gone');
    saveMessage({ id: 'm-gone', node_id: 'n-gone', role: 'user', content: 'zebra in a deleted workspace', seq: 1, created_at: 1 });
    getDb().prepare('UPDATE workspaces SET deleted_at = 5 WHERE id = ?').run('ws-gone');
    const slot = assistantSlotFor(assistant.nodeId, assistant.workspaceId);
    const all = await call(slot, 'search_messages', { query: 'zebra', limit: 2 });
    assert.match(all.text, /Found 2 matches/, 'neither the assistant\'s own conversation nor a deleted workspace is a result, and they do not use up the limit');
    assert.doesNotMatch(all.text, /n-gone/);
    assert.doesNotMatch(all.text, new RegExp(assistant.nodeId));
    const one = await call(slot, 'search_messages', { query: 'zebra', workspaceId: 'ws-b' });
    assert.match(one.text, /Found 1 match:/);
    assert.match(one.text, /workspace: ws-b, node: n-b1, message: m-b1\)/);
  });
});
