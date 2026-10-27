import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentRuntime, AgentSession, ModelInfo } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { beginTurn, finalizeTurn } from '../src/services/dbRepository';
import { conversationCompletionCounter } from '../src/services/conversationUpdates';
import { reportConversationNoChange } from '../src/services/scheduledJobs/conversationBatch';
import { closeDb, getDb, initDb } from '../src/services/db';
import { getNode, getWorkspace, listMessages, listTrees, saveWorkspace } from '../src/services/dbRepository';
import { ChatScheduledJobExecutor, isSchedulableWorkspace, summarizeReply } from '../src/services/scheduledJobs/chatExecutor';
import type { ScheduledJobRecord, ScheduledJobRunRecord } from '../src/services/scheduledJobs/repository';
import { ScheduledJobsRepository } from '../src/services/scheduledJobs/repository';
import { ScheduledJobEventBus } from '../src/services/scheduledJobs/events';
import { ScheduledJobScheduler } from '../src/services/scheduledJobs/scheduler';

function iterator(events: NormalizedEvent[], gate?: Promise<void>): AsyncIterableIterator<NormalizedEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (index === 1 && gate) await gate;
      return index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined };
    },
  };
}

function job(overrides: Partial<ScheduledJobRecord> = {}): ScheduledJobRecord {
  return {
    id: 'job-1', ownerUserId: null, workspaceId: 'ws-1', name: 'Digest', prompt: 'Summarize the news',
    schedule: { kind: 'every', everySeconds: 3600 }, runtimeId: 'kiro', providerId: 'kiro', modelId: 'auto',
    reasoning: null, permissionMode: 'trust', sessionMode: 'fresh', persistentNodeId: null, notify: true,
    enabled: true, autoPaused: false, consecutiveFailures: 0, timeoutSeconds: 1800, nextRunAt: null,
    lastRunAt: null, lastStatus: null, lastError: null, createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

const run = { id: 'run-1' } as ScheduledJobRunRecord;

const MODELS: ModelInfo[] = [
  { id: 'auto', isDefault: true, supportsReasoning: false },
  { id: 'deep', supportsReasoning: true, supportedReasoningLevels: ['low', 'high'], defaultReasoning: 'high' },
];

/** Just enough of a runtime for profile resolution. */
function fakeRuntime(id: string): AgentRuntime | undefined {
  if (id !== 'kiro') return undefined;
  return {
    id: 'kiro',
    label: 'Kiro',
    capabilities: {
      modes: false, permissions: true, models: true, providerModels: false, reasoning: true,
      supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: false,
      saveContext: false, spawnBranches: false, nativeResume: false,
    },
    listModels: async () => MODELS,
  } as unknown as AgentRuntime;
}

describe('ChatScheduledJobExecutor', () => {
  let tmpDir: string;
  let hub: ChatHub;
  let sessions: Array<{ input: { workspaceId: string; nodeId: string }; prompt: string | null }>;
  let events: NormalizedEvent[];
  let gate: Promise<void> | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-scheduled-executor-'));
    process.env.MICHI_DATA_DIR = tmpDir;
    closeDb();
    initDb();
    saveWorkspace({ id: 'ws-1', name: 'Research', cwd: '/tmp/research', created_at: 1, updated_at: 1, active_tree_id: null });
    hub = new ChatHub({ retentionMs: 100 });
    sessions = [];
    events = [{ kind: 'chunk', text: '## Today\n\n**Markets** were calm. [TITLE: Daily]' }, { kind: 'turn_end', stopReason: 'end_turn' }];
    gate = undefined;
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function executor(onSend?: (prompt: string, nodeId: string) => void): ChatScheduledJobExecutor {
    return new ChatScheduledJobExecutor({
      chatHub: hub,
      getRuntime: fakeRuntime,
      clock: () => Date.parse('2026-10-16T09:00:00Z'),
      ensureSession: async (input) => {
        const record = { input, prompt: null as string | null };
        sessions.push(record);
        const session: AgentSession = {
          id: input.nodeId, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
          send: (prompt) => { record.prompt = prompt; onSend?.(prompt, input.nodeId); return iterator(events, gate); },
          cancel: () => {},
        };
        return session;
      },
    });
  }

  test('consumes a real source batch via the bound confirmation tool; its own output is excluded', async () => {
    const repo = new ScheduledJobsRepository();
    let confirmations = 0;
    const worker = executor((prompt, nodeId) => {
      assert.match(prompt, /source conclusion/);
      const batchToken = prompt.match(/with batchToken ([a-f0-9-]+),/)?.[1];
      assert.ok(batchToken);
      assert.equal(reportConversationNoChange({ nodeId, workspaceId: 'ws-1' }, { batchToken: 'old', turnIds: ['source-turn'], reason: 'unchanged' }).isError, true);
      assert.equal(reportConversationNoChange({ nodeId, workspaceId: 'foreign' }, { batchToken, turnIds: ['source-turn'], reason: 'unchanged' }).isError, true);
      assert.equal(reportConversationNoChange({ nodeId, workspaceId: 'ws-1' }, { batchToken, turnIds: ['unseen'], reason: 'unchanged' }).isError, true);
      assert.notEqual(reportConversationNoChange({ nodeId, workspaceId: 'ws-1' }, { batchToken, turnIds: ['source-turn'], reason: 'Already recorded; no page change needed.' }).isError, true);
      confirmations++;
    });
    const scheduler = new ScheduledJobScheduler({ repository: repo, executor: worker,
      events: new ScheduledJobEventBus(), workspaceExists: () => true, runtimeExists: () => true });
    try {
      const consumer = scheduler.createJob({ workspaceId: 'ws-1', name: 'Increment', prompt: 'Review new conclusions',
        schedule: { kind: 'every', everySeconds: 3600 }, runtimeId: 'kiro', conversationUpdates: true });
      getDb().prepare("INSERT INTO nodes (id, workspace_id, kind, status, created_at) VALUES ('source', 'ws-1', 'chat', 'idle', 1)").run();
      let source = createDurableTurn({ turnId: 'source-turn', assistantId: 'source-reply', nodeId: 'source', workspaceId: 'ws-1', displayUserText: 'source question', startedAt: 1 });
      beginTurn(source);
      source = applyTurnEvent(source, { event: 'chunk', data: { seq: 1, text: 'source conclusion' } } as ChatStreamEvent);
      finalizeTurn(applyTurnEvent(source, { event: 'done', data: { seq: 2, stopReason: 'end_turn' } } as ChatStreamEvent));
      await scheduler.runNow(consumer.id);
      for (let i = 0; i < 30 && scheduler.getJob(consumer.id).activeRunId; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(confirmations, 1);
      assert.equal(scheduler.getJob(consumer.id).lastStatus, 'succeeded');
      assert.equal(scheduler.getJob(consumer.id).conversationCursor, 1);
      assert.equal(conversationCompletionCounter('ws-1'), 1, 'the scheduled self-turn does not re-enter the input stream');
      const before = sessions.length;
      await scheduler.runNow(consumer.id);
      assert.equal(sessions.length, before, 'empty wakeup never opens a runtime session');
    } finally {
      await scheduler.stop(); worker.dispose();
    }
  });

  for (const cancellation of ['abort', 'ownership'] as const) {
    test(`${cancellation} during session setup never dispatches a late native turn`, async () => {
      let ready!: () => void;
      const sessionStarted = new Promise<void>(resolve => { ready = resolve; });
      let release!: (session: AgentSession) => void;
      const pending = new Promise<AgentSession>(resolve => { release = resolve; });
      let sends = 0;
      let current = true;
      const controller = new AbortController();
      const worker = new ChatScheduledJobExecutor({ chatHub: hub, getRuntime: fakeRuntime,
        ensureSession: async () => { ready(); return pending; } });
      const starting = worker.start(job(), run, { onAttention: () => {}, signal: controller.signal, isCurrent: () => current });
      await sessionStarted;
      if (cancellation === 'abort') controller.abort(); else current = false;
      release({ id: 'late-session', runtimeId: 'kiro', send: () => { sends++; return iterator(events); },
        cancel: () => {}, getHistory: () => [], getPendingAssistant: () => undefined } as AgentSession);
      await assert.rejects(starting, /cancelled or lost scheduler ownership/);
      assert.equal(sends, 0);
      assert.equal(listTrees('ws-1').length, 0, 'unused fresh graph is rolled back');
      worker.dispose();
    });
  }

  test('abort during pending ChatHub start reserves the exact turn id and cancels after attachment', async () => {
    let began!: () => void;
    const starting = new Promise<void>(resolve => { began = resolve; });
    let attach!: () => void;
    const gate = new Promise<void>(resolve => { attach = resolve; });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    let attached = false;
    const cancelled: Array<{ id?: string; attached: boolean }> = [];
    const worker = new ChatScheduledJobExecutor({ getRuntime: fakeRuntime,
      ensureSession: async input => ({ id: input.nodeId, runtimeId: 'kiro' } as AgentSession),
      chatHub: {
        startRequestedSelfTurn: async args => { began(); await gate; attached = true;
          return { turnId: args.turnId, assistantId: 'reply', done, existing: false }; },
        cancel: (_chatId, id) => { cancelled.push({ id, attached }); return attached; },
        requestedTurnStatus: () => 'cancelled', subscribeBackground: () => () => {},
      } });
    const controller = new AbortController();
    const promise = worker.start(job(), run, { onAttention: () => {}, signal: controller.signal });
    await starting; controller.abort();
    assert.equal(cancelled.length, 1); assert.equal(cancelled[0].attached, false);
    attach(); const handle = await promise;
    assert.equal(cancelled.length, 2); assert.equal(cancelled[1].attached, true);
    assert.equal(cancelled[0].id, handle.turnId); assert.equal(cancelled[1].id, handle.turnId);
    let settled = false; void handle.done.then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'cancellation acceptance is not executor completion');
    finish(); await handle.done; worker.dispose();
  });

  test('opens a new thread, runs the prompt and summarizes the reply', async () => {
    const handle = await executor().start(job(), run, { onAttention: () => {} });
    const outcome = await handle.done;

    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.summary, 'Today Markets were calm.');
    assert.equal(sessions[0].prompt, 'Summarize the news');
    const node = getNode(handle.nodeId);
    assert.equal(node?.tree_id, handle.treeId);
    assert.equal(node?.runtime_id, 'kiro');
    assert.equal(node?.model_id, 'auto');
    assert.equal(node?.permission_mode, 'trust');
    assert.match(node?.title ?? '', /^Digest · /);
    const tree = listTrees('ws-1').find((candidate) => candidate.id === handle.treeId);
    assert.equal(tree?.root_node_id, handle.nodeId);
    // The user's active thread is untouched.
    assert.equal(getWorkspace('ws-1')?.active_tree_id ?? null, null);
    assert.equal(getWorkspace('ws-1')?.cwd, '/tmp/research');
    const messages = listMessages(handle.nodeId);
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(messages[0].content, 'Summarize the news');
  });

  test('reuses the persistent thread on later runs', async () => {
    const first = await executor().start(job({ sessionMode: 'persistent' }), run, { onAttention: () => {} });
    await first.done;
    const second = await executor().start(job({ sessionMode: 'persistent', persistentNodeId: first.nodeId }), run, { onAttention: () => {} });
    await second.done;
    assert.equal(second.nodeId, first.nodeId);
    assert.equal(getNode(first.nodeId)?.title, 'Digest');
    assert.equal(listMessages(first.nodeId).length, 4);
  });

  test('reports approval requests from the scheduled turn', async () => {
    let release!: () => void;
    gate = new Promise((resolve) => { release = resolve; });
    events = [
      { kind: 'permission_request', requestId: 1, title: 'Run tests', options: [] },
      { kind: 'chunk', text: 'ok' },
      { kind: 'turn_end', stopReason: 'end_turn' },
    ];
    const attention: string[] = [];
    const handle = await executor().start(job(), run, { onAttention: (kind) => attention.push(kind) });
    release();
    await handle.done;
    assert.deepEqual(attention, ['approval']);
  });

  test('marks the thread as hosting a scheduled run until the turn settles', async () => {
    let release!: () => void;
    gate = new Promise((resolve) => { release = resolve; });
    const runner = executor();
    const handle = await runner.start(job(), run, { onAttention: () => {} });
    assert.equal(runner.isRunningOn(handle.nodeId), true);
    assert.equal(runner.isRunningOn('n-other'), false);
    release();
    await handle.done;
    assert.equal(runner.isRunningOn(handle.nodeId), false);
  });

  for (const cancellation of ['manual', 'timeout'] as const) {
    test(`${cancellation} cancellation interrupts the scheduled native runtime before delayed side effects`, async () => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      let began!: () => void;
      const nativeStarted = new Promise<void>((resolve) => { began = resolve; });
      let nativeCancelled = false;
      let cancellations = 0;
      let sideEffect = false;
      let nodeId: string | undefined;
      const runner = new ChatScheduledJobExecutor({
        chatHub: hub,
        getRuntime: fakeRuntime,
        ensureSession: async (input) => {
          nodeId = input.nodeId;
          return {
            id: input.nodeId, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
            send: () => (async function* (): AsyncIterableIterator<NormalizedEvent> {
              began();
              yield { kind: 'chunk', text: 'started native work' };
              await blocked;
              if (!nativeCancelled) sideEffect = true;
              yield { kind: 'turn_end', stopReason: nativeCancelled ? 'cancelled' : 'end_turn' };
            })(),
            cancel: () => { cancellations++; nativeCancelled = true; release(); },
          };
        },
      });
      const lifecycle = new ScheduledJobEventBus();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      lifecycle.subscribe({ send: (event) => { if (event.phase === 'finished') finish(); } });
      const scheduler = new ScheduledJobScheduler({
        repository: new ScheduledJobsRepository(), executor: runner,
        events: lifecycle, workspaceExists: () => true, runtimeExists: () => true,
        cancelGraceMs: 100,
      });
      const scheduled = scheduler.createJob({
        workspaceId: 'ws-1', name: 'Cancellable work', prompt: 'perform delayed work',
        runtimeId: 'kiro', modelId: 'auto', schedule: { kind: 'every', everySeconds: 3600 }, timeoutSeconds: 60,
      });
      const realSetTimeout = global.setTimeout;
      if (cancellation === 'timeout') {
        global.setTimeout = ((fn: () => void, ms: number) =>
          realSetTimeout(fn, ms === 60_000 ? 0 : ms)) as typeof setTimeout;
      }
      try {
        await scheduler.runNow(scheduled.id);
        await nativeStarted;
        if (cancellation === 'manual') assert.equal(scheduler.cancelActiveRun(scheduled.id), true);
        // Exercise the real scheduler -> executor -> Hub -> Session path.
        await finished;
        assert.equal(cancellations, 1);
        assert.equal(sideEffect, false, 'cancelled native work must never perform its delayed write');
        assert.equal(scheduler.listRuns(scheduled.id)[0].status, cancellation === 'timeout' ? 'timed_out' : 'cancelled');
        assert.equal(runner.isRunningOn(nodeId!), false);
        assert.equal(hub.isOwnerTurnActive(nodeId!), false);
      } finally {
        global.setTimeout = realSetTimeout;
        release();
        await scheduler.stop();
      }
    });
  }

  test('a failed turn reports failure with the stored error', async () => {
    const failing = new ChatScheduledJobExecutor({
      chatHub: hub,
      getRuntime: fakeRuntime,
      ensureSession: async (input) => ({
        id: input.nodeId, runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
        send: () => ({
          [Symbol.asyncIterator]() { return this; },
          async next(): Promise<IteratorResult<NormalizedEvent>> { throw new Error('model unavailable'); },
        }),
        cancel: () => {},
      }),
    });
    const handle = await failing.start(job(), run, { onAttention: () => {} });
    const outcome = await handle.done;
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error ?? '', /model unavailable|error/);
  });

  test('removes the empty thread when no session can be opened', async () => {
    const failing = new ChatScheduledJobExecutor({ chatHub: hub, getRuntime: fakeRuntime, ensureSession: async () => null });
    await assert.rejects(() => failing.start(job(), run, { onAttention: () => {} }), /not available/);
    assert.equal(listTrees('ws-1').length, 0);
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM nodes').get() as { count: number }).count, 0);
  });

  test('drops a reasoning level the model cannot use and keeps a supported one', async () => {
    const plain = await executor().start(job({ modelId: 'auto', reasoning: 'high' }), run, { onAttention: () => {} });
    await plain.done;
    assert.equal(getNode(plain.nodeId)?.reasoning ?? null, null);
    // Profile-free runtimes carry no provider id even when the job names one.
    assert.equal(getNode(plain.nodeId)?.provider_id ?? null, null);

    const deep = await executor().start(job({ modelId: 'deep', reasoning: 'low' }), run, { onAttention: () => {} });
    await deep.done;
    assert.equal(getNode(deep.nodeId)?.model_id, 'deep');
    assert.equal(getNode(deep.nodeId)?.reasoning, 'low');

    const fallback = await executor().start(job({ modelId: 'deep', reasoning: 'medium' }), run, { onAttention: () => {} });
    await fallback.done;
    assert.equal(getNode(fallback.nodeId)?.reasoning, 'high');
  });

  test('a profile resolved when the run started replaces the job\'s own runtime fields', async () => {
    const resolved = await executor().start(job({ runtimeId: null, providerId: null, modelId: null, reasoning: null }), run, {
      onAttention: () => {}, runtimeProfile: { runtimeId: 'kiro', providerId: null, modelId: 'deep', reasoning: 'low' },
    });
    await resolved.done;
    const node = getNode(resolved.nodeId);
    assert.equal(node?.runtime_id, 'kiro');
    assert.equal(node?.model_id, 'deep');
    assert.equal(node?.reasoning, 'low');

    await assert.rejects(() => executor().start(job({ runtimeId: 'kiro' }), run, {
      onAttention: () => {}, runtimeProfile: { runtimeId: 'missing', providerId: null, modelId: null, reasoning: null },
    }), /"missing" is not available/, 'the job\'s runtime is not a fallback for a resolved one');
  });

  test('rejects a runtime that is not registered', async () => {
    await assert.rejects(() => executor().start(job({ runtimeId: 'missing' }), run, { onAttention: () => {} }), /"missing" is not available/);
    assert.equal(listTrees('ws-1').length, 0);
  });

  test('refuses a trashed workspace', async () => {
    getDb().prepare('UPDATE workspaces SET deleted_at = 5 WHERE id = ?').run('ws-1');
    await assert.rejects(() => executor().start(job(), run, { onAttention: () => {} }), /missing or in Trash/);
  });

  test("never runs in the assistant's hidden workspace", async () => {
    getDb().prepare('UPDATE workspaces SET settings = ? WHERE id = ?').run(JSON.stringify({ system: 'assistant' }), 'ws-1');
    await assert.rejects(() => executor().start(job(), run, { onAttention: () => {} }), /system workspace/);
    assert.equal(listTrees('ws-1').length, 0, 'no thread is created there');
    assert.equal(sessions.length, 0, 'no session is opened');
    // The scheduler's workspace check (server.ts) refuses it before then:
    // creating, updating, running now and due runs all treat it as missing.
    assert.equal(isSchedulableWorkspace(getWorkspace('ws-1')), false);
    assert.equal(isSchedulableWorkspace({ deleted_at: null, settings: JSON.stringify({ theme: 'dark' }) }), true);
    assert.equal(isSchedulableWorkspace({ deleted_at: 5, settings: null }), false);
    assert.equal(isSchedulableWorkspace(undefined), false);
  });

  test('summarizeReply strips sentinels and markdown and truncates', () => {
    assert.equal(summarizeReply('[FOLLOW-UP 1/3: next?]\n'), null);
    assert.equal(summarizeReply('- one\n- two\n```js\ncode\n```\nSee [docs](https://x.test)'), 'one two See docs');
    assert.equal(summarizeReply('a'.repeat(400))?.length, 280);
  });
});
