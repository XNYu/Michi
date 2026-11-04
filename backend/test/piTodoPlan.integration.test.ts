import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatStreamEvent, PlanEntry } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import { PiRuntime } from '../src/agents/pi/PiRuntime';
import { loadPiAi } from '../src/agents/pi/piAi';
import { configureRuntimeDeps, __resetRuntimeDeps } from '../src/agents/runtimeDeps';
import { clearAllSessions } from '../src/agents/sessionRegistry';
import type { AgentSession } from '../src/agents/types';
import { resolveBranchBoundary, toBranchContext } from '../src/services/branchBoundary';
import { closeDb, initDb } from '../src/services/db';
import {
  getNode, getWorkspace, getWorkspaceInstructions, listMessages, saveEdge, saveNode, saveTree, saveWorkspace,
  setEdgeForkProvenance,
} from '../src/services/dbRepository';
import { sessionPlanSnapshot } from '../src/services/planSnapshot';
import { chatOwner } from './helpers/owners';

type ToolCall = { name: string; arguments: Record<string, unknown> };
/** One scripted model response: tool calls (one assistant message) or the final text. */
type Step = ToolCall[] | string;

const entry = (content: string, status: PlanEntry['status']): PlanEntry => ({ content, priority: 'medium', status });

describe('Pi todo tool plan: tool call -> plan event -> persistence -> replay -> restore -> branch', () => {
  let dir: string;
  let runtime: PiRuntime;
  let hub: ChatHub;
  let script: Step[] = [];
  let calls = 0;
  const oldDataDir = process.env.MICHI_DATA_DIR;
  const restores: Array<() => void> = [];

  function patch(modulePath: string, key: string, value: unknown) {
    const mod = require(modulePath);
    const original = mod[key];
    mod[key] = value;
    restores.push(() => { mod[key] = original; });
  }

  function chatNode(id: string, parent: string | null, createdAt: number) {
    saveNode({ id, workspace_id: 'ws-1', tree_id: 'tree-1', parent_node_id: parent,
      kind: 'chat', status: 'idle', minimized: 0, spawned_by_agent: 0, created_at: createdAt });
  }

  function branch(child: string, parent: string, boundaryMessageId: string | null) {
    chatNode(child, parent, Date.now());
    const id = `${parent}-${child}`;
    saveEdge({ id, workspace_id: 'ws-1', source_node_id: parent, target_node_id: child, kind: 'branch', created_at: null });
    if (boundaryMessageId) setEdgeForkProvenance(id, { forkBoundaryMessageId: boundaryMessageId });
  }

  function sessionOptions(nodeId: string) {
    return { sessionId: nodeId, owner: chatOwner(nodeId), ownerUserId: null, workspaceId: 'ws-1', cwd: dir,
      provider: 'openai', model: 'gpt-4.1-mini', enableFollowUps: false };
  }

  /** Run one ChatHub turn with the scripted model; returns the events a subscriber saw for that turn. */
  async function turn(session: AgentSession, steps: Step[], turnId: string): Promise<ChatStreamEvent[]> {
    script = [...steps];
    const received: ChatStreamEvent[] = [];
    const detach = hub.subscribe(session.id, { send: (event) => received.push(event), close: () => {} });
    const started = await hub.startTurn({ chatId: session.id, nodeId: session.id, text: `run ${turnId}`, session, turnId });
    await started.done;
    detach();
    assert.equal(script.length, 0, `${turnId}: the model consumed its whole script`);
    // Subscribing first replays the previous turn's retained log; skip it.
    const start = received.findIndex((event) => event.event === 'turn_start' && event.data.turnId === turnId);
    assert.ok(start >= 0, `${turnId}: turn_start was delivered`);
    return received.slice(start);
  }

  const plans = (events: ChatStreamEvent[]) => events
    .filter((event): event is Extract<ChatStreamEvent, { event: 'plan' }> => event.event === 'plan')
    .map((event) => event.data.entries);

  function persistedPlans(nodeId: string): Array<PlanEntry[] | undefined> {
    return listMessages(nodeId).filter((row) => row.role === 'assistant')
      .map((row) => (row.metadata ? JSON.parse(row.metadata).plan : undefined));
  }

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-pi-todo-plan-'));
    process.env.MICHI_DATA_DIR = dir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-1', name: 'Workspace', created_at: 1, updated_at: 1, active_tree_id: 'tree-1' });
    saveTree({ id: 'tree-1', workspace_id: 'ws-1', root_node_id: 'node-1', last_active_at: 1, created_at: 1 });
    chatNode('node-1', null, 1);
    configureRuntimeDeps({
      dataDir: dir,
      historyStore: { getNode, listMessages, getWorkspace, getWorkspaceInstructions, getPlanSnapshot: sessionPlanSnapshot },
      providerKeys: { getProviderApiKey: () => 'synthetic-key' },
      agentConfig: { getAgentConfig: () => ({ runtime: 'pi', provider: 'openai', modelByRuntime: {}, reasoningByRuntime: {} }),
        resolveModel: () => 'gpt-4.1-mini', resolveReasoning: () => undefined },
    });
    const ai: any = await loadPiAi();
    patch(require.resolve('../src/services/piMcpConfig'), 'readPiMcpServers', () => []);
    patch(require.resolve('../src/agents/pi/piAi'), 'loadPiAi', async () => ({ ...ai, streamSimple: (model: any) => {
      const step = script.shift() ?? 'Done.';
      calls += 1;
      const toolCalls = typeof step === 'string' ? [] : step;
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: typeof step === 'string'
          ? [{ type: 'text', text: step }]
          : toolCalls.map((call, index) => ({ type: 'toolCall', id: `call-${calls}-${index}`, name: call.name, arguments: call.arguments })),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: typeof step === 'string' ? 'stop' : 'toolUse', timestamp: Date.now() };
      const stream = ai.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        if (typeof step === 'string') stream.push({ type: 'text_delta', delta: step, contentIndex: 0, partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message });
      });
      return stream;
    } }));
    runtime = new PiRuntime({});
    hub = new ChatHub({ retentionMs: 60_000, titleGenerator: null, pageManifestBuilder: () => '' });
  });

  after(async () => {
    await runtime.shutdown();
    clearAllSessions();
    __resetRuntimeDeps();
    while (restores.length > 0) restores.pop()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    if (oldDataDir === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = oldDataDir;
  });

  const todo = (args: Record<string, unknown>): ToolCall => ({ name: 'todo', arguments: { __tool_use_purpose: 'Track the work', ...args } });
  const turnOnePlan = [entry('Write tests', 'in_progress'), entry('Implement tool', 'completed')];

  test('a normal chat turn streams, persists and replays every todo change as a plan', async () => {
    const session = await runtime.newSession(sessionOptions('node-1'));
    const events = await turn(session, [
      [todo({ action: 'add', items: [{ content: 'Write tests' }, { content: 'Implement tool', status: 'in_progress' }] })],
      // Two calls in one response apply in order: finish #2, then start #1.
      [todo({ action: 'update', id: 2, status: 'completed' }), todo({ action: 'update', id: 1, status: 'in_progress' })],
      [todo({ action: 'update', id: 9, status: 'completed' })],
      [todo({ action: 'list' })],
      'Planned.',
    ], 'turn-1');

    assert.deepEqual(plans(events), [
      [entry('Write tests', 'pending'), entry('Implement tool', 'in_progress')],
      [entry('Write tests', 'pending'), entry('Implement tool', 'completed')],
      turnOnePlan,
    ], 'one plan per change; the failed update and the list emit none');
    const todoChips = events.filter((event) => event.event === 'tool_call_update' && event.data.title === 'todo');
    assert.deepEqual(todoChips.map((event) => (event.data as { status: string }).status),
      ['completed', 'completed', 'completed', 'failed', 'completed'], 'no Ask prompt blocked the tool');
    assert.equal(events.some((event) => event.event === 'permission_request'), false);

    assert.deepEqual(persistedPlans('node-1'), [turnOnePlan], 'the final plan is stored with the turn');

    const replay: ChatStreamEvent[] = [];
    hub.subscribe('node-1', { send: (event) => replay.push(event), close: () => {} });
    assert.deepEqual(plans(replay), plans(events), 'a late subscriber replays the same plans');
    assert.equal(replay.find((event) => event.event === 'done')?.data.persisted, true);
  });

  test('a restored session continues from the persisted plan, including a cleared one', async () => {
    await runtime.releaseSession('node-1', chatOwner('node-1'));
    let session = await runtime.loadSession(sessionOptions('node-1'));
    const resumed = await turn(session, [[todo({ action: 'update', id: 1, status: 'completed' })], 'Continued.'], 'turn-2');
    assert.deepEqual(plans(resumed), [[entry('Write tests', 'completed'), entry('Implement tool', 'completed')]]);

    const cleared = await turn(session, [[todo({ action: 'replace', items: [] })], 'Cleared.'], 'turn-3');
    assert.deepEqual(plans(cleared), [[]]);
    assert.deepEqual(persistedPlans('node-1').at(-1), [], 'a cleared plan is stored, not dropped');

    await runtime.releaseSession('node-1', chatOwner('node-1'));
    session = await runtime.newSession({ ...sessionOptions('node-1'),
      replayHistory: listMessages('node-1').map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content })) });
    const afterClear = await turn(session, [[todo({ action: 'add', items: [{ content: 'Next' }] })], 'Added.'], 'turn-4');
    assert.deepEqual(plans(afterClear), [[entry('Next', 'pending')]], 'an older plan is not resurrected');
  });

  test('a branch starts from the parent plan at its cut and never changes the parent', async () => {
    const parentRows = listMessages('node-1');
    const turnOneAnswer = parentRows.filter((row) => row.role === 'assistant')[0].id;
    branch('node-2', 'node-1', turnOneAnswer);
    const boundary = resolveBranchBoundary({ childNodeId: 'node-2' });
    assert.ok(boundary);
    const child = await runtime.newSession({ ...sessionOptions('node-2'), parentChatId: 'node-1', branchContext: toBranchContext(boundary) });
    const childEvents = await turn(child, [[todo({ action: 'update', id: 1, status: 'completed' })], 'Branch work.'], 'turn-child');
    assert.deepEqual(plans(childEvents), [[entry('Write tests', 'completed'), entry('Implement tool', 'completed')]],
      'the child inherits the plan at the cut, not the parent tail');
    assert.deepEqual(listMessages('node-1'), parentRows, 'the parent rows are untouched');

    // The live parent keeps its own list.
    const parent = await runtime.loadSession(sessionOptions('node-1'));
    const parentEvents = await turn(parent, [[todo({ action: 'add', items: [{ content: 'Parent only' }] })], 'Parent.'], 'turn-5');
    assert.deepEqual(plans(parentEvents), [[entry('Next', 'pending'), entry('Parent only', 'pending')]]);

    // A restored child resumes its own plan.
    await runtime.releaseSession('node-2', chatOwner('node-2'));
    const restoredChild = await runtime.loadSession(sessionOptions('node-2'));
    const restoredEvents = await turn(restoredChild, [[todo({ action: 'remove', id: 2 })], 'Trimmed.'], 'turn-child-2');
    assert.deepEqual(plans(restoredEvents), [[entry('Write tests', 'completed')]]);
  });

  test('without a host branch context the node edge cut is used, through ancestors with no plan', async () => {
    const turnOneAnswer = listMessages('node-1').filter((row) => row.role === 'assistant')[0].id;
    branch('node-3', 'node-1', turnOneAnswer);
    // node-4 branches from node-3 before node-3 has any messages of its own.
    branch('node-4', 'node-3', null);
    const grandchild = await runtime.loadSession(sessionOptions('node-4'));
    const events = await turn(grandchild, [[todo({ action: 'add', items: [{ content: 'Deeper' }] })], 'Deeper.'], 'turn-grandchild');
    assert.deepEqual(plans(events), [[...turnOnePlan, entry('Deeper', 'pending')]]);
    assert.deepEqual(persistedPlans('node-3'), [], 'the intermediate ancestor is untouched');
  });
});
