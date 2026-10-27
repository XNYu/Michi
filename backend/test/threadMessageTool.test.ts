/**
 * send_to_thread: same-workspace only, optional per-message user approval,
 * and delivery through a backend-requested turn in the target thread.
 * Uses a fresh temp SQLite MICHI_DATA_DIR per test (same pattern as
 * paneInspection.test.ts); runtime session and ChatHub are injected fakes.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { THREAD_MESSAGE_MAX_CHARS, applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import { beginTurn, finalizeTurn, saveNode, saveTree, saveWorkspace, type NodeRow } from '../src/services/dbRepository';
import { readPaneOutputTool, waitPaneTool } from '../src/agents/paneInspectionTools';

import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import {
  askUserThreadMessageApprover,
  configureThreadMessaging,
  sendToThreadTool,
  threadMessageApprovalTitle,
  type ThreadMessageApprovalRequest,
  type ThreadMessageApprover,
  type ThreadMessageCaller,
  type ThreadMessagingDeps,
} from '../src/agents/threadMessageTool';
import { ensureAssistant } from '../src/assistant/store';
import type { StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import { runOwner } from './helpers/owners';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';

function seedWorkspace(id: string): void {
  saveWorkspace({
    id, name: id, created_at: 1, updated_at: 1,
    active_tree_id: null, cwd: null, settings: null,
    deleted_at: null, archived_at: null,
  });
}

function seedNode(id: string, opts: { workspaceId?: string; kind?: string; status?: string; title?: string;
  bound?: boolean; treeId?: string | null } = {}): void {
  const row: NodeRow = {
    id, workspace_id: opts.workspaceId ?? WS,
    tree_id: opts.treeId ?? null,
    parent_node_id: null,
    kind: opts.kind ?? 'chat', title: opts.title ?? `Title ${id}`, branch_overview: null,
    status: opts.status ?? 'idle',
    position_x: null, position_y: null, minimized: 0, deleted_at: null,
    deletion_group_id: null, spawned_by_agent: 0, current_mode_id: null,
    pane_width: null, digest: null, follow_ups: null, follow_ups_source_message_id: null,
    acp_session_id: opts.bound === false ? null : id, runtime_id: 'kiro', provider_id: null,
    model_id: null, reasoning: null, resume_fingerprint: null,
    composer_draft: null, external_session_id: null, trim_snapshot: null,
    created_at: 1,
  };
  saveNode(row);
}

function caller(overrides: Partial<ThreadMessageCaller> = {}): ThreadMessageCaller {
  return { ownerUserId: null, workspaceId: WS, nodeId: 'n-a', isAgentRun: false, ...overrides };
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join('');
}

interface Harness {
  deps: ThreadMessagingDeps;
  ensured: Array<{ ownerUserId: string; workspaceId: string; nodeId: string }>;
  started: StartRequestedSelfTurnArgs[];
  locks: string[];
}

function harness(overrides: Partial<ThreadMessagingDeps> = {}): Harness {
  const ensured: Harness['ensured'] = [];
  const started: StartRequestedSelfTurnArgs[] = [];
  const locks: string[] = [];
  const session = { id: 'n-b', runtimeId: 'kiro' } as unknown as AgentSession;
  const deps: ThreadMessagingDeps = {
    ensureSession: async (input) => { ensured.push(input); return session; },
    startTurn: async (args): Promise<StartedRequestedSelfTurn> => {
      started.push(args);
      return { turnId: args.turnId, assistantId: `self-${args.nodeId}-${args.turnId}`, done: Promise.resolve(), existing: false };
    },
    acquireRestoreLock: async (nodeId) => { locks.push(nodeId); return () => {}; },
    newTurnId: () => 'turn-1',
    startWaitMs: 50,
    ...overrides,
  };
  return { deps, ensured, started, locks };
}

function approver(result: Awaited<ReturnType<ThreadMessageApprover>>): ThreadMessageApprover & { calls: number } {
  const state = { calls: 0 };
  const fn: ThreadMessageApprover = async () => { state.calls += 1; return result; };
  return Object.defineProperty(fn, 'calls', { get: () => state.calls }) as ThreadMessageApprover & { calls: number };
}

describe('send_to_thread', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-thread-message-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace(WS);
    seedWorkspace(OTHER_WS);
    seedNode('n-a', { title: 'Research notes' });
    seedNode('n-b', { title: 'Implementation' });
  });

  afterEach(() => {
    configureThreadMessaging(null);
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('refuses invalid targets before asking the user', async () => {
    seedNode('n-other', { workspaceId: OTHER_WS });
    seedNode('n-unbound', { bound: false });
    seedNode('n-digest', { kind: 'digest' });
    seedNode('n-archived', { status: 'archived' });
    saveTree({
      id: 't-archived', workspace_id: WS, root_node_id: 'n-in-archived-tree',
      name: null, archived_at: 5, pinned_at: null, last_active_at: 1, created_at: 1,
    });
    seedNode('n-in-archived-tree', { treeId: 't-archived' });
    const cases: Array<[string, ThreadMessageCaller, Record<string, unknown>, RegExp]> = [
      ['other workspace', caller(), { nodeId: 'n-other', text: 'hi' }, /^NOT_FOUND/],
      ['missing node', caller(), { nodeId: 'n-missing', text: 'hi' }, /^NOT_FOUND/],
      ['current thread', caller(), { nodeId: 'n-a', text: 'hi' }, /^INVALID_TARGET/],
      ['never started', caller(), { nodeId: 'n-unbound', text: 'hi' }, /^NOT_STARTED/],
      ['digest node', caller(), { nodeId: 'n-digest', text: 'hi' }, /^INVALID_TARGET/],
      ['archived node', caller(), { nodeId: 'n-archived', text: 'hi' }, /^READ_ONLY/],
      ['archived tree', caller(), { nodeId: 'n-in-archived-tree', text: 'hi' }, /^READ_ONLY/],
      ['agent run caller', caller({ isAgentRun: true, nodeId: null }), { nodeId: 'n-b', text: 'hi' }, /^UNSUPPORTED/],
      ['unbound caller', caller({ nodeId: null }), { nodeId: 'n-b', text: 'hi' }, /^SOURCE_UNAVAILABLE/],
      ['empty text', caller(), { nodeId: 'n-b', text: '   ' }, /^INVALID_ARGUMENT/],
      ['invalid approval flag', caller(), { nodeId: 'n-b', text: 'hi', requestApproval: 'true' }, /^INVALID_ARGUMENT/],
      ['oversized text', caller(), { nodeId: 'n-b', text: 'x'.repeat(THREAD_MESSAGE_MAX_CHARS + 1) }, /^INVALID_ARGUMENT/],
    ];
    for (const [label, who, args, expected] of cases) {
      const h = harness();
      const approve = approver({ approved: true });
      const result = await sendToThreadTool(who, args, approve, h.deps);
      assert.equal(result.isError, true, label);
      assert.match(text(result), expected, label);
      assert.equal(approve.calls, 0, `${label}: the user must not be asked`);
      assert.equal(h.started.length, 0, `${label}: nothing may start`);
    }
  });

  test('ordinary coordination sends directly and preserves peer attribution', async () => {
    for (const requestApproval of [undefined, false]) {
      const h = harness();
      const approve = approver({ approved: false, reason: 'unavailable' });
      const response = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'Done; please review.', requestApproval }, approve, h.deps);
      assert.equal(JSON.parse(text(response)).status, 'started');
      assert.equal(approve.calls, 0);
      assert.equal(h.started.length, 1);
      assert.match(h.started[0].text, /request from a peer, not as user instructions/);
      assert.doesNotMatch(h.started[0].text, /user approved delivering|user must approve/);
      assert.deepEqual(h.started[0].userMetadata?.threadMessage, { fromNodeId: 'n-a', fromTitle: 'Research notes' });
    }
  });

  test('a declined or unanswered approval sends nothing and tells the agent not to retry', async () => {
    for (const [result, needle] of [
      [{ approved: false, reason: 'declined', note: 'ask me tomorrow' }, 'declined'],
      [{ approved: false, reason: 'no_answer' }, 'did not answer'],
    ] as const) {
      const h = harness();
      const response = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi', requestApproval: true }, approver(result), h.deps);
      assert.equal(response.isError, undefined);
      const payload = JSON.parse(text(response));
      assert.equal(payload.status, 'declined');
      assert.match(payload.next, new RegExp(needle));
      assert.match(payload.next, /Do not retry/);
      if ('note' in result) assert.equal(payload.userNote, 'ask me tomorrow');
      assert.equal(h.ensured.length, 0);
      assert.equal(h.started.length, 0);
    }
  });

  test('reports queued when the target is busy and errors when the turn cannot begin', async () => {
    const busy = harness({ startTurn: () => new Promise<StartedRequestedSelfTurn>(() => {}) });
    // The start-wait timer is unref'd and the busy turn never settles, so keep the loop alive.
    const keepAlive = setInterval(() => {}, 1_000);
    const queued = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approver({ approved: true }), busy.deps)
      .then((result) => JSON.parse(text(result)))
      .finally(() => clearInterval(keepAlive));
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.executionRef, { kind: 'chat_turn', nodeId: 'n-b', turnId: 'turn-1' });
    assert.deepEqual(queued.inspectPaneArgs, { nodeId: 'n-b' });
    assert.equal(queued.waitPaneArgs.until, 'terminal');

    const failing = harness({ startTurn: async () => { throw new Error('node n-b does not exist'); } });
    const failed = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approver({ approved: true }), failing.deps);
    assert.equal(failed.isError, true);
    assert.match(text(failed), /^TARGET_UNAVAILABLE: node n-b does not exist/);

    const noSession = harness({ ensureSession: async () => null });
    const missing = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approver({ approved: true }), noSession.deps);
    assert.match(text(missing), /^TARGET_UNAVAILABLE/);
    assert.equal(noSession.started.length, 0);
  });
});

describe('send_to_thread follow-up arguments against the real pane tools', () => {
  let tmpDir: string;
  const binding = { ownerUserId: null, workspaceId: WS, backendConnectionId: 'local' };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-thread-message-reply-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace(WS);
    seedNode('n-a', { title: 'Research notes' });
    seedNode('n-b', { title: 'Implementation' });
    // The target's answered turn, as ChatHub persists a requested self-turn with a visible message.
    let snapshot = createDurableTurn({
      turnId: 'turn-1', assistantId: 'self-n-b-turn-1', nodeId: 'n-b', workspaceId: WS,
      displayUserText: 'attributed message', selfInitiated: true, keepUserMessage: true, startedAt: 100,
    });
    beginTurn(snapshot);
    snapshot = applyTurnEvent(snapshot, { event: 'chunk', data: { text: 'Reply from B', seq: 1 } } as ChatStreamEvent);
    snapshot = applyTurnEvent(snapshot, { event: 'done', data: { stopReason: 'end_turn', seq: 2 } } as ChatStreamEvent);
    finalizeTurn(snapshot);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('waitPaneArgs and readPaneOutputArgs work unchanged', async () => {
    const result = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approver({ approved: true }), harness().deps);
    const payload = JSON.parse(text(result));

    const waited = await waitPaneTool(binding, payload.waitPaneArgs);
    assert.equal(waited.isError, undefined, text(waited));
    assert.match(text(waited), /^reason: terminal$/m);
    assert.match(text(waited), /^outcome: completed$/m);

    const read = readPaneOutputTool(binding, payload.readPaneOutputArgs);
    assert.equal(read.isError, undefined, text(read));
    assert.match(text(read), /Reply from B/);
  });

  test('a locator for another pane than its executionRef is still rejected', async () => {
    const result = await waitPaneTool(binding, {
      nodeId: 'n-a', until: 'terminal', executionRef: { kind: 'chat_turn', nodeId: 'n-b', turnId: 'turn-1' },
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /does not belong to the target object/);
  });
});

describe('askUserThreadMessageApprover', () => {
  const request = { targetNodeId: 'n-b', targetTitle: 'Implementation', text: 'line one\nline two' };

  test('only the exact Send option approves', async () => {
    let asked: Array<{ question: string; options: Array<{ label: string }> }> = [];
    const answer = (value: string | null) => askUserThreadMessageApprover(async (questions) => {
      asked = questions;
      return value === null ? null : { [questions[0].question]: value };
    });
    assert.deepEqual(await answer('Send')(request), { approved: true });
    assert.match(asked[0].question, /"Implementation"/);
    assert.match(asked[0].question, /line one line two/);
    assert.deepEqual(asked[0].options.map((option) => option.label), ['Send', "Don't send"]);
    assert.deepEqual(await answer("Don't send")(request), { approved: false, reason: 'declined' });
    assert.deepEqual(await answer('send it later')(request), { approved: false, reason: 'declined', note: 'send it later' });
    assert.deepEqual(await answer(null)(request), { approved: false, reason: 'no_answer' });
    assert.deepEqual(await askUserThreadMessageApprover(undefined)(request), { approved: false, reason: 'unavailable' });
  });

  test('an exact request shows the whole message as sent, line breaks kept; others a one-line preview', async () => {
    const long = `${'first paragraph '.repeat(40)}\n\nsecond paragraph\n${'tail '.repeat(3000)}END`;
    assert.ok(long.length > 15_000 && long.length <= THREAD_MESSAGE_MAX_CHARS);
    let question = '';
    const approve = askUserThreadMessageApprover(async (questions) => { question = questions[0].question; return { [question]: 'Send' }; });

    assert.deepEqual(await approve({ ...request, text: long, targetWorkspaceName: 'Project B', exact: true }), { approved: true },
      'the answer is keyed by the full question');
    assert.ok(question.startsWith('Send this message to "Implementation" in Project B?\n\n'));
    assert.ok(question.endsWith(long), 'every character the target will get');

    await approve({ ...request, text: long });
    assert.ok(question.length < 400);
    assert.ok(question.endsWith('…”'));
    assert.doesNotMatch(question, /\n/);

    assert.deepEqual(threadMessageApprovalTitle({ ...request, text: long, exact: true }).detail, long);
    assert.ok(threadMessageApprovalTitle({ ...request, text: long }).detail.length <= 281);
  });

  test('the assistant\'s approval is exact; a thread\'s own stays a preview', async () => {
    const seen: ThreadMessageApprovalRequest[] = [];
    const record: ThreadMessageApprover = async (r) => { seen.push(r); return { approved: false, reason: 'declined' }; };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-thread-message-exact-'));
    process.env.MICHI_DATA_DIR = tmp;
    closeDb();
    initDb();
    try {
      seedWorkspace(WS);
      seedNode('n-a', { title: 'Research notes' });
      seedNode('n-b', { title: 'Implementation' });
      const deps = harness().deps;
      await sendToThreadTool({ ownerUserId: null, workspaceId: WS, nodeId: 'n-a', isAgentRun: false }, { nodeId: 'n-b', text: 'hi', requestApproval: true }, record, deps);
      const assistant = ensureAssistant();
      await sendToThreadTool({ ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId, isAgentRun: false, assistant: true },
        { nodeId: 'n-b', text: 'hi', requestApproval: true }, record, deps);
      assert.deepEqual(seen.map((r) => r.exact ?? false), [false, true]);
    } finally {
      closeDb();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('the assistant\'s send_to_thread targets', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-thread-message-system-'));
    process.env.MICHI_DATA_DIR = tmp;
    closeDb();
    initDb();
  });
  afterEach(() => {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('no system workspace holds a target, whatever kind it is', async () => {
    const assistant = ensureAssistant();
    saveWorkspace({ id: 'ws-sys', name: 'System', created_at: 1, updated_at: 1, settings: null });
    getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify({ system: 'other' }), 'ws-sys');
    saveTree({ id: 't-sys', workspace_id: 'ws-sys', root_node_id: 'n-sys', last_active_at: 1, created_at: 1 });
    saveNode({ id: 'n-sys', workspace_id: 'ws-sys', tree_id: 't-sys', kind: 'chat', title: 'Hidden', status: 'idle', minimized: 0,
      spawned_by_agent: 0, acp_session_id: 'n-sys', runtime_id: 'claude', created_at: 1 });
    let asked = 0;
    const result = await sendToThreadTool(
      { ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId, isAgentRun: false, assistant: true },
      { nodeId: 'n-sys', text: 'hi' }, async () => { asked += 1; return { approved: true }; }, harness().deps,
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /^INVALID_TARGET/);
    assert.equal(asked, 0);
  });

  /** The assistant, and a started chat in another workspace for it to message. */
  function assistantAndTarget() {
    const assistant = ensureAssistant();
    seedWorkspace('ws-user');
    seedNode('n-target', { workspaceId: 'ws-user', title: 'Release checklist' });
    const who: ThreadMessageCaller = { ownerUserId: null, workspaceId: assistant.workspaceId, nodeId: assistant.nodeId, isAgentRun: false, assistant: true };
    return { assistant, who };
  }

  test('re-checks the target after approval', async () => {
    const { who } = assistantAndTarget();
    const h = harness();
    const approve: ThreadMessageApprover = async () => {
      getDb().prepare("UPDATE nodes SET status = 'archived' WHERE id = 'n-target'").run();
      return { approved: true };
    };
    const result = await sendToThreadTool(who, { nodeId: 'n-target', text: 'hi', requestApproval: true }, approve, h.deps);
    assert.equal(result.isError, true);
    assert.match(text(result), /^READ_ONLY/);
    assert.equal(h.ensured.length, 0);
    assert.equal(h.started.length, 0);
  });

  test('fails closed when the runtime cannot ask for approval', async () => {
    const { assistant, who } = assistantAndTarget();
    const h = harness();
    const direct = await sendToThreadTool(who, { nodeId: 'n-target', text: 'hi', requestApproval: true }, approver({ approved: false, reason: 'unavailable' }), h.deps);
    assert.equal(direct.isError, true);
    assert.match(text(direct), /^APPROVAL_UNAVAILABLE/);
    // An assistant slot offers no send_to_thread, and its start_conversation fails closed the same way without ask_user.
    configureThreadMessaging(h.deps);
    try {
      seedWorkspace('ws-other');
      const slot = new McpSlotRegistry().create(assistant.nodeId, tmp, null, {
        onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unsupported in test' }), restricted: true,
      } as never, { nodeId: assistant.nodeId, workspaceId: assistant.workspaceId });
      const registered = (buildMcpServerForSlot(slot) as any)._registeredTools;
      assert.equal(registered['send_to_thread'], undefined, "the assistant's catalog no longer offers it");
      const viaMcp = await registered['start_conversation'].handler({ workspaceId: 'ws-other', text: 'hi' }, {});
      assert.match(viaMcp.content[0].text, /^APPROVAL_UNAVAILABLE/);
    } finally {
      configureThreadMessaging(null);
    }
    assert.equal(h.started.length, 0);
    assert.equal(h.ensured.length, 0);
  });

  test('Agent Run slots never register send_to_thread, even assistant-marked and allow-listed', () => {
    const { assistant } = assistantAndTarget();
    const slot = new McpSlotRegistry().create('attempt-1', tmp, null, {
      onSpawnBranches: async () => [], onSaveArtifact: () => null, onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'unsupported in test' }), onAskUser: async () => ({}),
      owner: runOwner('run-1', 'attempt-1'),
      exposedToolNames: new Set(['send_to_thread']), restricted: true,
    } as never, { nodeId: null, workspaceId: assistant.workspaceId });
    assert.equal((buildMcpServerForSlot(slot) as any)._registeredTools['send_to_thread'], undefined);
  });
});

describe('send_to_thread MCP registration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-thread-message-mcp-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    delete process.env.MICHI_CLOUD;
    closeDb();
    initDb();
    seedWorkspace(WS);
    seedNode('n-a', { title: 'Research notes' });
    seedNode('n-b', { title: 'Implementation' });
  });

  afterEach(() => {
    configureThreadMessaging(null);
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function callbacks(onAskUser?: (questions: Array<{ question: string }>) => Promise<Record<string, string> | null>) {
    return {
      onSpawnBranches: async () => [],
      onSaveArtifact: () => null,
      onUpdateArtifact: () => null,
      onShowImage: () => ({ error: 'unsupported in test' }),
      ...(onAskUser ? { onAskUser } : {}),
    };
  }

  test('chat slots send without ask_user, but explicit approval still fails closed', async () => {
    const h = harness();
    configureThreadMessaging(h.deps);
    const slot = new McpSlotRegistry().create('n-a', tmpDir, null, callbacks() as never, { nodeId: 'n-a', workspaceId: WS });
    const tool = (buildMcpServerForSlot(slot) as any)._registeredTools['send_to_thread'];
    const sent = await tool.handler({ nodeId: 'n-b', text: 'hi' }, {});
    assert.equal(JSON.parse(sent.content[0].text).status, 'started');
    const result = await tool.handler({ nodeId: 'n-b', text: 'hi', requestApproval: true }, {});
    assert.match(result.content[0].text, /^APPROVAL_UNAVAILABLE/);
    assert.equal(h.started.length, 1);
  });
});
