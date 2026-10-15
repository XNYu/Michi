/**
 * send_to_thread: same-workspace only, explicit per-message user approval,
 * and delivery through a backend-requested turn in the target thread.
 * Uses a fresh temp SQLite MICHI_DATA_DIR per test (same pattern as
 * paneInspection.test.ts); runtime session and ChatHub are injected fakes.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  THREAD_MESSAGE_BODY_MARKER,
  THREAD_MESSAGE_MAX_CHARS,
  applyTurnEvent,
  createDurableTurn,
  type ChatStreamEvent,
} from 'michi-shared';
import { closeDb, getDb, initDb } from '../src/services/db';
import {
  beginTurn,
  finalizeTurn,
  saveNode,
  saveTree,
  saveWorkspace,
  setAiGlobalContext,
  type NodeRow,
} from '../src/services/dbRepository';
import { inspectPaneTool, readPaneOutputTool, waitPaneTool } from '../src/agents/paneInspectionTools';
import { DISABLED_MESSAGE } from '../src/services/globalContext';
import { LOCAL_AGENT_OWNER_ID } from '../src/services/agentOwner';
import { McpSlotRegistry, buildMcpServerForSlot } from '../src/services/mcpServer';
import {
  askUserThreadMessageApprover,
  configureThreadMessaging,
  sendToThreadTool,
  type ThreadMessageApprover,
  type ThreadMessageCaller,
  type ThreadMessagingDeps,
} from '../src/agents/threadMessageTool';
import type { StartRequestedSelfTurnArgs, StartedRequestedSelfTurn } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';

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

  test('delivers an approved message as an attributed requested turn in the target thread', async () => {
    const h = harness();
    const approve = approver({ approved: true });
    const result = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'Please review the API section.' }, approve, h.deps);

    assert.equal(result.isError, undefined, text(result));
    const payload = JSON.parse(text(result));
    assert.equal(payload.status, 'started');
    const executionRef = { kind: 'chat_turn', nodeId: 'n-b', turnId: 'turn-1' };
    assert.deepEqual(payload.executionRef, executionRef);
    assert.deepEqual(payload.waitPaneArgs, { nodeId: 'n-b', until: 'terminal', executionRef, timeoutMs: 30_000 });
    assert.deepEqual(payload.readPaneOutputArgs, { nodeId: 'n-b', selection: 'execution', executionRef });
    assert.equal(approve.calls, 1);
    assert.deepEqual(h.ensured, [{ ownerUserId: LOCAL_AGENT_OWNER_ID, workspaceId: WS, nodeId: 'n-b' }]);
    assert.deepEqual(h.locks, ['n-b']);
    assert.equal(h.started.length, 1);
    const turn = h.started[0];
    assert.equal(turn.chatId, 'n-b');
    assert.equal(turn.nodeId, 'n-b');
    assert.equal(turn.turnId, 'turn-1');
    assert.equal(turn.ownerUserId, null);
    assert.equal(turn.displayText, turn.text, 'stored text must equal what the runtime receives');
    assert.match(turn.text, /^\[Thread message\] From "Research notes" \(nodeId n-a\)/);
    assert.match(turn.text, /not typed by the user/);
    assert.ok(turn.text.endsWith(`${THREAD_MESSAGE_BODY_MARKER}Please review the API section.`));
    assert.deepEqual(turn.userMetadata, { threadMessage: { fromNodeId: 'n-a', fromTitle: 'Research notes' } });
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

  test('respects the workspace AI navigation switch', async () => {
    setAiGlobalContext(WS, false);
    const h = harness();
    const approve = approver({ approved: true });
    const result = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approve, h.deps);
    assert.equal(result.isError, true);
    assert.equal(text(result), DISABLED_MESSAGE);
    assert.equal(approve.calls, 0);
  });

  test('a declined or unanswered approval sends nothing and tells the agent not to retry', async () => {
    for (const [result, needle] of [
      [{ approved: false, reason: 'declined', note: 'ask me tomorrow' }, 'declined'],
      [{ approved: false, reason: 'no_answer' }, 'did not answer'],
    ] as const) {
      const h = harness();
      const response = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approver(result), h.deps);
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

  test('fails closed when the runtime cannot ask for approval', async () => {
    const h = harness();
    const result = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approver({ approved: false, reason: 'unavailable' }), h.deps);
    assert.equal(result.isError, true);
    assert.match(text(result), /^APPROVAL_UNAVAILABLE/);
    assert.equal(h.started.length, 0);
  });

  test('re-checks the target after approval', async () => {
    const h = harness();
    const approve: ThreadMessageApprover = async () => {
      getDb().prepare("UPDATE nodes SET status = 'archived' WHERE id = 'n-b'").run();
      return { approved: true };
    };
    const result = await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approve, h.deps);
    assert.equal(result.isError, true);
    assert.match(text(result), /^READ_ONLY/);
    assert.equal(h.ensured.length, 0);
    assert.equal(h.started.length, 0);
  });

  test('reports queued when the target is busy and errors when the turn cannot begin', async () => {
    const busy = harness({ startTurn: () => new Promise<StartedRequestedSelfTurn>(() => {}) });
    const queued = JSON.parse(text(await sendToThreadTool(caller(), { nodeId: 'n-b', text: 'hi' }, approver({ approved: true }), busy.deps)));
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

  test('the argument shapes a model sent in practice all succeed now', async () => {
    const ref = { kind: 'chat_turn', nodeId: 'n-b', turnId: 'turn-1' };
    for (const args of [
      { until: 'terminal', executionRef: ref, timeoutMs: 30_000 },
      { until: 'terminal', nodeId: 'n-b', executionRef: { kind: 'chat_turn', turnId: 'turn-1' }, timeoutMs: 30_000 },
      { until: 'terminal', nodeId: 'n-b', executionRef: ref, timeoutMs: 30_000 },
    ]) {
      const waited = await waitPaneTool(binding, args);
      assert.equal(waited.isError, undefined, `${JSON.stringify(args)}: ${text(waited)}`);
      assert.match(text(waited), /^reason: terminal$/m);
    }
    assert.match(text(readPaneOutputTool(binding, { selection: 'execution', executionRef: ref })), /Reply from B/);
    assert.match(text(inspectPaneTool(binding, { executionRef: ref })), /chat_turn turn-1 on node n-b status=completed/);
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

  test('chat slots route approval through the slot ask_user channel', async () => {
    const h = harness();
    configureThreadMessaging(h.deps);
    let answer = "Don't send";
    const slot = new McpSlotRegistry().create('n-a', tmpDir, null,
      callbacks(async (questions) => ({ [questions[0].question]: answer })) as never,
      { nodeId: 'n-a', workspaceId: WS });
    const tool = (buildMcpServerForSlot(slot) as any)._registeredTools['send_to_thread'];
    assert.ok(tool, 'send_to_thread must be registered on chat slots');

    const declined = await tool.handler({ nodeId: 'n-b', text: 'hi' }, {});
    assert.equal(JSON.parse(declined.content[0].text).status, 'declined');
    assert.equal(h.started.length, 0);

    answer = 'Send';
    const sent = await tool.handler({ nodeId: 'n-b', text: 'hi' }, {});
    assert.equal(JSON.parse(sent.content[0].text).status, 'started');
    assert.equal(h.started.length, 1);
    assert.equal(h.started[0].userMetadata?.threadMessage?.fromNodeId, 'n-a');
  });

  test('chat slots without an ask_user channel never send', async () => {
    const h = harness();
    configureThreadMessaging(h.deps);
    const slot = new McpSlotRegistry().create('n-a', tmpDir, null, callbacks() as never, { nodeId: 'n-a', workspaceId: WS });
    const tool = (buildMcpServerForSlot(slot) as any)._registeredTools['send_to_thread'];
    const result = await tool.handler({ nodeId: 'n-b', text: 'hi' }, {});
    assert.match(result.content[0].text, /^APPROVAL_UNAVAILABLE/);
    assert.equal(h.started.length, 0);
  });

  test('Agent Run slots never register send_to_thread, even when allow-listed', () => {
    const slot = new McpSlotRegistry().create('attempt-1', tmpDir, LOCAL_AGENT_OWNER_ID, {
      ...callbacks(async () => ({})),
      owner: { kind: 'agent_run', runId: 'run-1', attemptId: 'attempt-1' },
      exposedToolNames: new Set(['send_to_thread']),
    } as never, { nodeId: null, workspaceId: WS });
    assert.equal((buildMcpServerForSlot(slot) as any)._registeredTools['send_to_thread'], undefined);
  });
});
