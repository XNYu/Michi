import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { log } from '../src/services/logger';
import { ReportedRuntimeError } from 'michi-runtime/internal/contract/errors';
import type { ChatStreamEvent } from 'michi-shared';
import type { DurableTurnSnapshot } from 'michi-shared';
import { chatOwner, runOwner } from './helpers/owners';

function asyncIteratorFrom(events: NormalizedEvent[]): AsyncIterableIterator<NormalizedEvent> {
  let i = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (i >= events.length) return { done: true, value: undefined };
      return { done: false, value: events[i++] };
    },
  };
}

function sessionFrom(events: NormalizedEvent[]): AgentSession {
  return {
    id: 'session-1',
    runtimeId: 'kiro',
    getHistory: () => [],
    getPendingAssistant: () => undefined,
    send: () => asyncIteratorFrom(events),
    cancel: () => {},
  };
}

function hubWithPersistence(overrides: Partial<{
  begin(snapshot: DurableTurnSnapshot): void;
  checkpoint(snapshot: DurableTurnSnapshot): void;
  finalize(snapshot: DurableTurnSnapshot): void;
}> = {}): ChatHub {
  return new ChatHub({
    retentionMs: 100,
    workspaceIdForNode: () => 'ws-test',
    persistence: {
      begin: overrides.begin ?? (() => {}),
      checkpoint: overrides.checkpoint ?? (() => {}),
      finalize: overrides.finalize ?? (() => {}),
    },
  });
}

describe('ChatHub.startTurn', () => {
  it('forwards durable attachment metadata to the runtime turn input', async () => {
    const hub = hubWithPersistence();
    let capturedInput: Parameters<AgentSession['send']>[1];
    const session: AgentSession = {
      ...sessionFrom([]),
      send: (_text, input) => {
        capturedInput = input;
        return asyncIteratorFrom([{ kind: 'turn_end', stopReason: 'end_turn' }]);
      },
    };

    const { done } = await hub.startTurn({
      chatId: 'attachment-chat',
      nodeId: 'attachment-node',
      text: 'Inspect the image',
      displayText: 'Inspect the image',
      userMetadata: {
        attachments: [{ name: 'screen.png', absPath: '/tmp/screen.png' }],
      },
      session,
    });
    await done;

    assert.deepEqual(capturedInput?.attachments, [{ name: 'screen.png', absPath: '/tmp/screen.png' }]);
    assert.ok(capturedInput?.assistantMessageId?.startsWith('a-attachment-node-'));
    assert.equal(capturedInput?.humanOrigin, undefined, 'a turn is not human unless the user route says so');
    assert.ok(capturedInput?.userMessageId);
  });

  it('marks only composer turns as human-origin', async () => {
    const hub = hubWithPersistence();
    const inputs: Array<Parameters<AgentSession['send']>[1]> = [];
    const session: AgentSession = {
      ...sessionFrom([]),
      send: (_text, input) => {
        inputs.push(input);
        return asyncIteratorFrom([{ kind: 'turn_end', stopReason: 'end_turn' }]);
      },
    };
    const human = await hub.startTurn({ chatId: 'origin-chat', nodeId: 'origin-node', text: 'ultracode: audit', session, humanOrigin: true });
    await human.done;
    // send_to_thread deliveries reuse startTurn without the flag.
    const relayed = await hub.startTurn({ chatId: 'origin-chat', nodeId: 'origin-node', text: 'ultracode: from another agent', session });
    await relayed.done;
    assert.deepEqual(inputs.map((input) => input?.humanOrigin), [true, undefined]);
  });

  it('opts renderer feeds into owner-scoped foreground delivery and cursor replay', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    const otherOwner: ChatStreamEvent[] = [];
    const detach = hub.subscribeBackground({ includeForeground: true, ownerUserId: 'owner',
      send: (_chatId, event, selfInitiated) => { assert.equal(selfInitiated, false); received.push(event); }, close() {} });
    const detachOther = hub.subscribeBackground({ includeForeground: true, ownerUserId: 'other',
      send: (_chatId, event) => otherOwner.push(event), close() {} });
    const { done, turnId } = await hub.startTurn({ chatId: 'phone', nodeId: 'phone', ownerUserId: 'owner',
      text: 'from phone', userMetadata: { quotedText: 'quote' },
      session: sessionFrom([{ kind: 'chunk', text: 'answer' }, { kind: 'turn_end', stopReason: 'end_turn' }]) });
    await done;
    assert.deepEqual(received.map(event => event.event), ['turn_start', 'chunk', 'done']);
    assert.deepEqual((received[0].data as any).userMetadata, { quotedText: 'quote' });
    assert.equal(otherOwner.length, 0);
    detach(); detachOther();
    const replay: ChatStreamEvent[] = [];
    hub.subscribeBackground({ includeForeground: true, ownerUserId: 'owner', send: (_id, event) => replay.push(event), close() {} },
      { cursors: { phone: { turnId, seq: 1 } } })();
    assert.deepEqual(replay.map(event => event.event), ['done']);
    hub.subscribeBackground({ includeForeground: true, ownerUserId: 'other', send: (_id, event) => otherOwner.push(event), close() {} })();
    assert.equal(otherOwner.length, 0);
  });

  it('routes foreground turns only to direct subscribers and self turns only to background subscribers', async () => {
    const hub = hubWithPersistence();
    const direct: ChatStreamEvent[] = [];
    const background: Array<{ chatId: string; event: ChatStreamEvent }> = [];
    hub.subscribeBackground({
      send: (chatId, event) => background.push({ chatId, event }),
      close: () => {},
    });

    const { done, turnId } = await hub.startTurn({
      chatId: 'separated-chat',
      nodeId: 'separated-node',
      text: 'foreground',
      turnId: 'foreground-turn',
      session: sessionFrom([{ kind: 'chunk', text: 'foreground body' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    hub.subscribeTurn('separated-chat', turnId, { send: (event) => direct.push(event), close: () => {} });
    await done;
    assert.equal(direct.some((event) => event.event === 'chunk'), true);
    assert.equal(background.length, 0);

    direct.length = 0;
    hub.startSelfTurn({
      chatId: 'separated-chat',
      nodeId: 'separated-node',
      events: asyncIteratorFrom([{ kind: 'chunk', text: 'runtime body' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(direct.length, 0);
    assert.equal(background.every(({ chatId, event }) => chatId === 'separated-chat' && event.data.turnId !== undefined), true);
    assert.deepEqual(background.map(({ event }) => event.event), ['turn_start', 'chunk', 'done']);
    // logger writes asynchronously in the node:test sandbox; let its queued
    // append settle before this focused transport test completes.
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  it('queues a self turn behind an active foreground turn for the same chat', async () => {
    let releaseForeground!: () => void;
    const foreground = (async function* (): AsyncIterableIterator<NormalizedEvent> {
      yield { kind: 'chunk', text: 'foreground body' } as NormalizedEvent;
      await new Promise<void>((resolve) => { releaseForeground = resolve; });
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    })();
    const hub = hubWithPersistence();
    const background: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => background.push(event), close: () => {} });
    const session = sessionFrom([]);
    session.send = () => foreground;
    const { done } = await hub.startTurn({
      chatId: 'mutex-chat', nodeId: 'mutex-node', text: 'foreground', session,
    });
    hub.startSelfTurn({
      chatId: 'mutex-chat', nodeId: 'mutex-node',
      events: asyncIteratorFrom([{ kind: 'chunk', text: 'self body' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(background.length, 0);
    releaseForeground();
    await done;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(background.map((event) => event.event), ['turn_start', 'chunk', 'done']);
  });
  it('publishes branch_overview before done on the owner message stream', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('owner-chat', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    const { done } = await hub.startTurn({
      chatId: 'owner-chat',
      nodeId: 'owner-node',
      text: 'Summarize this branch',
      session: sessionFrom([
        { kind: 'chunk', text: '[BRANCH-OVERVIEW: Owner stream summary.]' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    const overviewIndex = received.findIndex((ev) => ev.event === 'branch_overview');
    const doneIndex = received.findIndex((ev) => ev.event === 'done');
    assert(overviewIndex >= 0, 'expected a branch_overview event');
    assert(doneIndex > overviewIndex, 'branch_overview must arrive before done');
  });

  it('uses structured overview metadata without emitting a duplicate sentinel fallback', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('structured-overview-chat', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    const { done } = await hub.startTurn({
      chatId: 'structured-overview-chat',
      nodeId: 'structured-overview-node',
      text: 'Update the overview',
      session: sessionFrom([
        { kind: 'chunk', text: 'Visible answer body.' },
        { kind: 'host_event', type: 'branch_overview', payload: { overview: 'Structured Tool overview.' } },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    const overviewEvents = received.filter((ev) => ev.event === 'branch_overview');
    assert.equal(overviewEvents.length, 1);
    assert.equal((overviewEvents[0].data as any).overview, 'Structured Tool overview.');
    assert(
      received.findIndex((ev) => ev.event === 'done') > received.findIndex((ev) => ev.event === 'branch_overview'),
      'structured overview must arrive before done',
    );
  });

  it('does not publish the sentinel overview again after the runtime reported one', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('reported-overview-chat', { send: (ev) => received.push(ev), close: () => {} });

    const { done } = await hub.startTurn({
      chatId: 'reported-overview-chat',
      nodeId: 'reported-overview-node',
      text: 'Update the overview',
      session: sessionFrom([
        { kind: 'chunk', text: 'Answer body.\n\n[BRANCH-OVERVIEW: Sentinel overview.]' },
        { kind: 'host_event', type: 'branch_overview', payload: { overview: 'Tool overview.' } },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    assert.deepEqual(
      received.filter((ev) => ev.event === 'branch_overview').map((ev) => (ev.data as any).overview),
      ['Tool overview.'],
    );
  });

  it('falls back to the sentinel overview when the reported one is empty or cannot be decoded', async (t) => {
    t.mock.method(log, 'warn', () => {});
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('fallback-overview-chat', { send: (ev) => received.push(ev), close: () => {} });

    const { done } = await hub.startTurn({
      chatId: 'fallback-overview-chat',
      nodeId: 'fallback-overview-node',
      text: 'Update the overview',
      session: sessionFrom([
        { kind: 'chunk', text: 'Answer body.\n\n[BRANCH-OVERVIEW: Sentinel overview.]' },
        { kind: 'host_event', type: 'branch_overview', payload: { overview: 7 } },
        { kind: 'host_event', type: 'branch_overview', payload: { overview: '  ' } },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    // The malformed one is dropped; the empty one still reaches the wire, as before.
    assert.deepEqual(
      received.filter((ev) => ev.event === 'branch_overview').map((ev) => (ev.data as any).overview),
      ['  ', 'Sentinel overview.'],
    );
  });

  it('puts a runtime_error code on the wire error but never its retryable', async () => {
    const wireError = async (chatId: string, session: AgentSession) => {
      const hub = hubWithPersistence();
      const received: ChatStreamEvent[] = [];
      hub.subscribe(chatId, { send: (ev) => received.push(ev), close: () => {} });
      const { done } = await hub.startTurn({ chatId, nodeId: `${chatId}-node`, text: 'hello', session });
      await done;
      const error = received.find((ev) => ev.event === 'error');
      assert.ok(error?.event === 'error');
      return error.data;
    };

    const coded = await wireError('coded-error-chat', sessionFrom([
      { kind: 'runtime_error', error: 'Session expired', code: 'auth', retryable: false },
    ]));
    assert.equal(coded.message, 'Session expired');
    assert.equal(coded.code, 'auth');
    assert.equal('recoverable' in coded, false);

    const uncoded = await wireError('uncoded-error-chat', sessionFrom([
      { kind: 'runtime_error', error: 'Model failed', retryable: true },
    ]));
    assert.equal(uncoded.message, 'Model failed');
    assert.equal('code' in uncoded, false);
    assert.equal('recoverable' in uncoded, false);

    // KiroSession's classification of a thrown error comes first.
    const tagged = await wireError('tagged-error-chat', {
      ...sessionFrom([]),
      send: async function* () {
        throw Object.assign(new ReportedRuntimeError({ error: 'Stream dropped', code: 'generic' }), { acpErrorKind: 'connection' });
      },
    });
    assert.equal(tagged.code, 'connection');

    // Only the error kinds the UI shows a banner for: a runtime's own code
    // must not set a wire code the client acts on.
    for (const code of ['turn_active', 'turn_persistence_failed', 'ENOTFOUND']) {
      const ignored = await wireError(`ignored-${code}-chat`, sessionFrom([
        { kind: 'runtime_error', error: 'Model failed', code },
      ]));
      assert.equal('code' in ignored, false, code);
    }
  });

  it('puts a runtime_error code on the wire error of a self turn', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('self-coded-error', { send: (ev) => received.push(ev), close: () => {} });
    hub.startSelfTurn({
      chatId: 'self-coded-error',
      nodeId: 'self-coded-error-node',
      events: asyncIteratorFrom([{ kind: 'runtime_error', error: 'Session expired', code: 'auth' }]),
    });
    await new Promise((r) => setTimeout(r, 50));
    const error = received.find((ev) => ev.event === 'error');
    assert.ok(error?.event === 'error');
    assert.equal(error.data.code, 'auth');
  });

  it('commits the canonical turn before broadcasting persisted done', async () => {
    const order: string[] = [];
    let begun: DurableTurnSnapshot | undefined;
    let finalized: DurableTurnSnapshot | undefined;
    let wirePrompt = '';
    const hub = hubWithPersistence({
      begin: (snapshot) => { begun = snapshot; },
      finalize: (snapshot) => { finalized = snapshot; order.push('finalize'); },
    });
    const received: ChatStreamEvent[] = [];
    hub.subscribe('durable-chat', {
      send: (ev) => {
        received.push(ev);
        if (ev.event === 'done') order.push('done');
      },
      close: () => {},
    });
    const session = sessionFrom([
      { kind: 'chunk', text: 'durable answer' },
      { kind: 'turn_end', stopReason: 'end_turn' },
    ]);
    session.send = (prompt) => {
      wirePrompt = prompt;
      return asyncIteratorFrom([
        { kind: 'chunk', text: 'durable answer' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]);
    };

    const { done } = await hub.startTurn({
      chatId: 'durable-chat',
      nodeId: 'durable-node',
      text: 'wire prompt with injected context',
      displayText: 'visible user text',
      userMetadata: { quotedText: 'quote' },
      session,
      turnId: 'turn-durable',
    });
    await done;

    assert.equal(wirePrompt, 'wire prompt with injected context');
    assert.equal(begun?.userMessage?.content, 'visible user text');
    assert.equal(begun?.userMessage?.metadata?.quotedText, 'quote');
    assert.equal(finalized?.assistantMessage.content, 'durable answer');
    assert.deepEqual(order, ['finalize', 'done']);
    const terminal = received.find((ev) => ev.event === 'done');
    assert.equal(terminal?.data.persisted, true);
  });

  it('emits a recoverable persistence error instead of done when finalize fails', async () => {
    const hub = hubWithPersistence({
      finalize: () => { throw new Error('disk full'); },
    });
    const received: ChatStreamEvent[] = [];
    hub.subscribe('failed-chat', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    const { done } = await hub.startTurn({
      chatId: 'failed-chat',
      nodeId: 'failed-node',
      text: 'hello',
      session: sessionFrom([
        { kind: 'chunk', text: 'answer exists' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    assert.equal(received.some((ev) => ev.event === 'done'), false);
    const terminal = received.find((ev) => ev.event === 'error');
    assert.equal(terminal?.data.code, 'turn_persistence_failed');
    assert.equal(terminal?.data.recoverable, true);
    assert.match(terminal?.data.message ?? '', /could not be committed/i);
  });

  it('does not reinterpret a successful model turn as a runtime error after a transient finalize failure', async () => {
    let finalizeCalls = 0;
    const hub = hubWithPersistence({
      finalize: () => {
        finalizeCalls += 1;
        if (finalizeCalls === 1) throw new Error('database busy');
      },
    });
    const received: ChatStreamEvent[] = [];
    hub.subscribe('transient-failure-chat', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    const { done } = await hub.startTurn({
      chatId: 'transient-failure-chat',
      nodeId: 'transient-failure-node',
      text: 'hello',
      session: sessionFrom([
        { kind: 'chunk', text: 'model completed successfully' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    assert.equal(finalizeCalls, 1);
    assert.equal(received.some((ev) => ev.event === 'done'), false);
    const terminal = received.find((ev) => ev.event === 'error');
    assert.equal(terminal?.data.code, 'turn_persistence_failed');
    assert.equal(terminal?.data.recoverable, true);
  });

  it('continues the model turn after a transient checkpoint failure', async () => {
    let checkpointCalls = 0;
    let finalized: DurableTurnSnapshot | undefined;
    const hub = hubWithPersistence({
      checkpoint: () => {
        checkpointCalls += 1;
        if (checkpointCalls === 1) throw new Error('database busy');
      },
      finalize: (snapshot) => { finalized = snapshot; },
    });
    const received: ChatStreamEvent[] = [];
    hub.subscribe('checkpoint-failure-chat', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    const { done } = await hub.startTurn({
      chatId: 'checkpoint-failure-chat',
      nodeId: 'checkpoint-failure-node',
      text: 'hello',
      session: sessionFrom([
        { kind: 'tool_call', toolCallId: 'tool-1', title: 'Read', status: 'running' },
        { kind: 'chunk', text: 'answer after checkpoint failure' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    assert.equal(checkpointCalls >= 1, true);
    assert.equal(finalized?.assistantMessage.content, 'answer after checkpoint failure');
    assert.equal(received.some((ev) => ev.event === 'done'), true);
    assert.equal(received.some((ev) => ev.event === 'error'), false);
  });

  it('throttles active tool output updates but checkpoints terminal tool state immediately', async () => {
    const checkpoints: DurableTurnSnapshot[] = [];
    const finalizations: DurableTurnSnapshot[] = [];
    const hub = new ChatHub({
      retentionMs: 100,
      checkpointIntervalMs: 60_000,
      workspaceIdForNode: () => 'ws-test',
      persistence: {
        begin: () => {},
        checkpoint: (snapshot) => { checkpoints.push(snapshot); },
        finalize: (snapshot) => { finalizations.push(snapshot); },
      },
    });
    const outputUpdates: NormalizedEvent[] = Array.from({ length: 100 }, (_, index) => ({
      kind: 'tool_call_update',
      toolCallId: 'tool-chatty',
      title: '',
      status: 'in_progress',
      output: `line ${index}`,
    }));

    const { done } = await hub.startTurn({
      chatId: 'chatty-tool-chat',
      nodeId: 'chatty-tool-node',
      text: 'run the command',
      session: sessionFrom([
        { kind: 'tool_call', toolCallId: 'tool-chatty', title: 'Bash', status: 'running' },
        ...outputUpdates,
        {
          kind: 'tool_call_update', toolCallId: 'tool-chatty', title: '',
          status: 'completed', output: 'final output',
        },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await done;

    assert.equal(checkpoints.length, 2, 'initial and terminal tool states should checkpoint');
    assert.equal(checkpoints[0].assistantMessage.toolCalls[0]?.status, 'running');
    assert.equal(checkpoints[1].assistantMessage.toolCalls[0]?.status, 'completed');
    assert.equal(checkpoints[1].assistantMessage.toolCalls[0]?.output, 'final output');
    assert.equal(finalizations.length, 1);
    assert.equal(finalizations[0].assistantMessage.toolCalls[0]?.output, 'final output');
  });
});

describe('ChatHub.startSelfTurn', () => {
  it('interrupts the owning runtime when a spontaneous self-turn is cancelled', async () => {
    const hub = hubWithPersistence();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    let nativeCancelled = false;
    let sideEffect = false;
    const session: AgentSession = {
      ...sessionFrom([]), id: 'idle-chat', owner: chatOwner('idle-node'),
      cancel: () => { cancellations++; nativeCancelled = true; release(); },
    };
    hub.startSelfTurn({
      chatId: 'idle-chat', nodeId: 'idle-node', session,
      events: (async function* (): AsyncIterableIterator<NormalizedEvent> {
        yield { kind: 'chunk', text: 'background work' };
        await blocked;
        if (!nativeCancelled) sideEffect = true;
        yield { kind: 'turn_end', stopReason: nativeCancelled ? 'cancelled' : 'end_turn' };
      })(),
    });
    const done = (hub as any).selfTurnQueues.get('idle-chat') as Promise<void>;
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(hub.isOwnerTurnActive('idle-chat'), true);
      assert.equal(hub.cancel('idle-chat'), true);
      assert.equal(cancellations, 1);
      await done;
      assert.equal(sideEffect, false);
      assert.equal(hub.isOwnerTurnActive('idle-chat'), false);
      assert.equal((hub as any).turns.get('idle-chat').snapshot.status, 'cancelled');
    } finally {
      release();
      await done;
    }
  });

  it('rejects mismatched spontaneous runtime owners before durable begin and drains their iterator', async () => {
    const mismatches: Array<Pick<AgentSession, 'id' | 'owner'>> = [
      { id: 'different-chat', owner: chatOwner('idle-node') },
      { id: 'idle-chat', owner: chatOwner('different-node') },
      { id: 'idle-chat', owner: runOwner('run', 'idle-chat') },
    ];
    for (const mismatch of mismatches) {
      let begins = 0;
      let drained = false;
      let cancellations = 0;
      const hub = hubWithPersistence({ begin: () => { begins++; } });
      hub.startSelfTurn({
        chatId: 'idle-chat', nodeId: 'idle-node',
        session: { ...sessionFrom([]), ...mismatch, cancel: () => { cancellations++; } },
        events: (async function* (): AsyncIterableIterator<NormalizedEvent> {
          try { yield { kind: 'turn_end', stopReason: 'end_turn' }; } finally { drained = true; }
        })(),
      });
      await (hub as any).selfTurnQueues.get('idle-chat');
      assert.equal(begins, 0);
      assert.equal(drained, true);
      assert.equal(hub.cancel('idle-chat'), false);
      assert.equal(cancellations, 0);
    }
  });

  it('does not remove a replacement runtime when a self-turn finishes', async () => {
    const hub = hubWithPersistence();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const session: AgentSession = { ...sessionFrom([]), id: 'idle-chat', owner: chatOwner('idle-node') };
    const replacement: AgentSession = { ...session, nativeSessionId: 'replacement' };
    hub.startSelfTurn({
      chatId: 'idle-chat', nodeId: 'idle-node', session,
      events: (async function* (): AsyncIterableIterator<NormalizedEvent> {
        await blocked;
        yield { kind: 'turn_end', stopReason: 'end_turn' };
      })(),
    });
    const done = (hub as any).selfTurnQueues.get('idle-chat') as Promise<void>;
    await new Promise<void>((resolve) => setImmediate(resolve));
    (hub as any).activeSessions.set('idle-chat', replacement);
    release();
    await done;
    assert.equal((hub as any).activeSessions.get('idle-chat'), replacement);
  });

  it('reserves the chat synchronously so a foreground turn cannot overtake a claimed self-turn', async () => {
    const hub = hubWithPersistence();
    hub.startSelfTurn({
      chatId: 'same-chat',
      nodeId: 'same-node',
      events: asyncIteratorFrom([
        { kind: 'chunk', text: 'self first' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });

    await assert.rejects(async () => hub.startTurn({
      chatId: 'same-chat',
      nodeId: 'same-node',
      text: 'foreground should wait',
      session: sessionFrom([{ kind: 'turn_end', stopReason: 'end_turn' }]),
    }), /already active/);

    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('drains a claimed self-turn when durable initialization fails', async () => {
    let finalized = false;
    const events = (async function* (): AsyncIterableIterator<NormalizedEvent> {
      try {
        yield { kind: 'chunk', text: 'orphaned output' } as NormalizedEvent;
        yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
      } finally {
        finalized = true;
      }
    })();
    const hub = new ChatHub({
      retentionMs: 100,
      workspaceIdForNode: () => null,
      persistence: { begin: () => {}, checkpoint: () => {}, finalize: () => {} },
    });

    hub.startSelfTurn({ chatId: 'gone-chat', nodeId: 'gone-node', events });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(finalized, true, 'idle-pump iterator must be released even when begin fails');
  });

  it('publishes branch_overview before done and replays it to late subscribers', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('chat-overview', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    hub.startSelfTurn({
      chatId: 'chat-overview',
      nodeId: 'node-overview',
      events: asyncIteratorFrom([
        { kind: 'chunk', text: 'Answer body.\n\n[BRANCH-OVERVIEW: The branch now has a durable summary.]' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });

    await new Promise((r) => setTimeout(r, 50));

    const overviewIndex = received.findIndex((ev) => ev.event === 'branch_overview');
    const doneIndex = received.findIndex((ev) => ev.event === 'done');
    assert(overviewIndex >= 0, 'expected a branch_overview event');
    assert(doneIndex > overviewIndex, 'branch_overview must arrive before done');
    assert.equal((received[overviewIndex].data as any).overview, 'The branch now has a durable summary.');

    const replayed: ChatStreamEvent[] = [];
    hub.subscribe('chat-overview', {
      send: (ev) => replayed.push(ev),
      close: () => {},
    });
    assert(replayed.some((ev) => ev.event === 'branch_overview'), 'expected branch_overview replay');
  });

  it('does not publish the sentinel overview again after the runtime reported one in a self turn', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('self-reported-overview', { send: (ev) => received.push(ev), close: () => {} });

    hub.startSelfTurn({
      chatId: 'self-reported-overview',
      nodeId: 'self-reported-overview-node',
      events: asyncIteratorFrom([
        { kind: 'chunk', text: 'Answer body.\n\n[BRANCH-OVERVIEW: Sentinel overview.]' },
        { kind: 'host_event', type: 'branch_overview', payload: { overview: 'Tool overview.' } },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(
      received.filter((ev) => ev.event === 'branch_overview').map((ev) => (ev.data as any).overview),
      ['Tool overview.'],
    );
    assert.equal(received.at(-1)?.event, 'done');
  });

  it('broadcasts turn_start with selfInitiated=true to subscribers', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];

    hub.subscribe('chat-1', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    hub.startSelfTurn({
      chatId: 'chat-1',
      nodeId: 'node-1',
      events: asyncIteratorFrom([
        { kind: 'chunk', text: 'Background task completed' } as NormalizedEvent,
        { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent,
      ]),
    });

    // Let the async runSelfTurn complete
    await new Promise((r) => setTimeout(r, 50));

    assert(received.length >= 3, `expected >=3 events, got ${received.length}`);

    // First event should be turn_start with selfInitiated
    const turnStart = received[0];
    assert.equal(turnStart.event, 'turn_start');
    assert.equal((turnStart.data as any).selfInitiated, true);
    assert.equal((turnStart.data as any).userText, '');

    // Should have a chunk
    const chunk = received.find((e) => e.event === 'chunk');
    assert(chunk, 'expected a chunk event');
    assert.equal((chunk!.data as any).text, 'Background task completed');

    // Should have done
    const done = received.find((e) => e.event === 'done');
    assert(done, 'expected a done event');
    assert(received.every((event) => event.data.chatId === 'chat-1' && event.data.nodeId === 'node-1'));
  });

  it('delivers cloud background frames only to the owner fixed at turn creation', async () => {
    const hub = hubWithPersistence();
    const ownerEvents: ChatStreamEvent[] = [];
    const foreignEvents: ChatStreamEvent[] = [];
    hub.subscribeBackground({
      ownerUserId: 'owner-a',
      send: (_chatId, event) => ownerEvents.push(event),
      close: () => {},
    });
    hub.subscribeBackground({
      ownerUserId: 'owner-b',
      send: (_chatId, event) => foreignEvents.push(event),
      close: () => {},
    });

    hub.startSelfTurn({
      chatId: 'owned-chat',
      nodeId: 'owned-node',
      ownerUserId: 'owner-a',
      events: asyncIteratorFrom([
        { kind: 'chunk', text: 'private output' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(ownerEvents.map((event) => event.event), ['turn_start', 'chunk', 'done']);
    assert.equal(foreignEvents.length, 0);
  });

  it('assistantId is prefixed with self-', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];

    hub.subscribe('chat-2', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    hub.startSelfTurn({
      chatId: 'chat-2',
      nodeId: 'node-2',
      events: asyncIteratorFrom([
        { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent,
      ]),
    });

    await new Promise((r) => setTimeout(r, 50));

    const turnStart = received[0];
    assert((turnStart.data as any).assistantId.startsWith('self-'));
  });

  it('does not interfere with a regular startTurn on a different chatId', async () => {
    const hub = hubWithPersistence();
    const selfEvents: ChatStreamEvent[] = [];
    const regularEvents: ChatStreamEvent[] = [];

    hub.subscribe('self-chat', {
      send: (ev) => selfEvents.push(ev),
      close: () => {},
    });
    hub.subscribe('regular-chat', {
      send: (ev) => regularEvents.push(ev),
      close: () => {},
    });

    hub.startSelfTurn({
      chatId: 'self-chat',
      nodeId: 'node-s',
      events: asyncIteratorFrom([
        { kind: 'chunk', text: 'self msg' } as NormalizedEvent,
        { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent,
      ]),
    });

    await new Promise((r) => setTimeout(r, 50));

    // Regular chat should have received nothing
    assert.equal(regularEvents.length, 0);
    // Self chat should have received events
    assert(selfEvents.length > 0);
  });
});

describe('ChatHub.cancel', () => {
  it('reserves a client turn id when Stop beats POST /message', async () => {
    const hub = hubWithPersistence();
    const session: AgentSession = {
      id: 'reserved-session', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent; },
      cancel: () => {},
    };

    assert.equal(hub.cancel('reserved-chat', 'reserved-turn'), false);
    await assert.rejects(
      async () => hub.startTurn({
        chatId: 'reserved-chat', nodeId: 'reserved-node', text: 'must not run',
        turnId: 'reserved-turn', session,
      }),
      /cancelled before it started/,
    );
  });

  it('ignores a delayed cancel from the previous turn', async () => {
    const hub = hubWithPersistence();
    const first = await hub.startTurn({
      chatId: 'reuse-chat', nodeId: 'reuse-node', text: 'first', turnId: 'turn-a',
      session: {
        id: 'session-a', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
        async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent; },
        cancel: () => {},
      },
    });
    await first.done;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let secondCancelled = 0;
    const second = await hub.startTurn({
      chatId: 'reuse-chat', nodeId: 'reuse-node', text: 'second', turnId: 'turn-b',
      session: {
        id: 'session-b', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
        async *send() { await blocked; yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent; },
        cancel: () => { secondCancelled += 1; },
      },
    });

    assert.equal(hub.cancel('reuse-chat', 'turn-a'), false);
    assert.equal(secondCancelled, 0);
    release();
    await second.done;
  });

  it('persists a runtime turn_end(error) as cancelled when cancellation won the race', async () => {
    let releaseTerminal!: () => void;
    const terminalReady = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let finalized: DurableTurnSnapshot | undefined;
    const hub = hubWithPersistence({ finalize: (snapshot) => { finalized = snapshot; } });
    const received: ChatStreamEvent[] = [];
    hub.subscribe('cancel-terminal-chat', { send: (ev) => received.push(ev), close: () => {} });
    const session: AgentSession = {
      id: 'cancel-terminal-session', runtimeId: 'claude', getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() {
        yield { kind: 'chunk', text: 'partial answer' } as NormalizedEvent;
        await terminalReady;
        yield { kind: 'turn_end', stopReason: 'error' } as NormalizedEvent;
      },
      cancel: () => {},
    };

    const { done } = await hub.startTurn({ chatId: 'cancel-terminal-chat', nodeId: 'cancel-terminal-node', text: 'hello', session });
    await new Promise((resolve) => setTimeout(resolve, 5));
    hub.cancel('cancel-terminal-chat');
    releaseTerminal();
    await done;

    assert.equal(received.find((event) => event.event === 'done')?.data.stopReason, 'cancelled');
    assert.equal(finalized?.status, 'cancelled');
  });

  it('treats a runtime error after cancel as cancelled, not error', async () => {
    const hub = hubWithPersistence();
    const received: ChatStreamEvent[] = [];
    hub.subscribe('cancel-chat', {
      send: (ev) => received.push(ev),
      close: () => {},
    });

    // Create a session whose send() throws after cancel is called
    let rejectSend: (err: Error) => void;
    const sendPromise = new Promise<NormalizedEvent>((_, reject) => {
      rejectSend = reject;
    });
    const session: AgentSession = {
      id: 'session-cancel',
      runtimeId: 'kiro',
      getHistory: () => [],
      getPendingAssistant: () => undefined,
      async *send() {
        yield { kind: 'chunk', text: 'partial answer' } as NormalizedEvent;
        await sendPromise; // will reject after cancel
      },
      cancel: () => {
        // Simulate kiro-cli behavior: cancel causes the prompt RPC to error
        rejectSend(new Error('session/prompt RPC cancelled'));
      },
    };

    const { done } = await hub.startTurn({
      chatId: 'cancel-chat',
      nodeId: 'cancel-node',
      text: 'hello',
      session,
    });

    // Give the stream time to emit the chunk
    await new Promise((r) => setTimeout(r, 20));

    // Now cancel
    hub.cancel('cancel-chat');

    await done;

    // Should have a done event with stopReason 'cancelled', not an error event
    const doneEv = received.find((ev) => ev.event === 'done');
    const errorEv = received.find((ev) => ev.event === 'error');
    assert(doneEv, 'expected a done event (cancel should be treated as graceful)');
    assert.equal(errorEv, undefined, 'should NOT have an error event after cancel');
    assert.equal(doneEv?.data.stopReason, 'cancelled');
  });
});

describe('ChatHub.startRequestedSelfTurn with a visible message (send_to_thread)', () => {
  function requestedHub(begins: DurableTurnSnapshot[]): ChatHub {
    return new ChatHub({
      retentionMs: 100,
      workspaceIdForNode: () => 'ws-test',
      lookupDurableTurn: () => null,
      persistence: { begin: (snapshot) => { begins.push(snapshot); }, checkpoint: () => {}, finalize: () => {} },
    });
  }

  it('interrupts the requested turn runtime instead of only marking its durable log cancelled', async () => {
    const hub = requestedHub([]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let cancellations = 0;
    let nativeCancelled = false;
    let sideEffect = false;
    const session: AgentSession = {
      ...sessionFrom([]),
      send: () => (async function* (): AsyncIterableIterator<NormalizedEvent> {
        yield { kind: 'chunk', text: 'working' };
        await blocked;
        if (!nativeCancelled) sideEffect = true;
        yield { kind: 'turn_end', stopReason: nativeCancelled ? 'cancelled' : 'end_turn' };
      })(),
      cancel: () => { cancellations++; nativeCancelled = true; release(); },
    };
    const started = await hub.startRequestedSelfTurn({
      chatId: 'scheduled-chat', nodeId: 'scheduled-chat', turnId: 'scheduled-turn',
      text: 'work', displayText: 'work', session,
    });
    try {
      assert.equal(hub.cancel('scheduled-chat', started.turnId), true);
      assert.equal(cancellations, 1);
      await started.done;
      assert.equal(sideEffect, false, 'the cancelled native work must not continue writing');
      assert.equal((hub as any).turns.get('scheduled-chat').snapshot.status, 'cancelled');
      assert.equal((hub as any).activeSessions.has('scheduled-chat'), false);
    } finally {
      release();
      await started.done;
    }
  });

  it('does not dispatch a requested turn cancelled while its provisional rows commit', async () => {
    let releaseBegin!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseBegin = resolve; });
    const hub = new ChatHub({
      retentionMs: 100, workspaceIdForNode: () => 'ws-test', lookupDurableTurn: () => null,
      persistence: { begin: () => blocked, checkpoint: () => {}, finalize: () => {} },
    });
    let sends = 0;
    const session = { ...sessionFrom([]), send: () => { sends++; return asyncIteratorFrom([]); } };
    const starting = hub.startRequestedSelfTurn({
      chatId: 'early-chat', nodeId: 'early-chat', turnId: 'early-turn', text: 'work', session,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(hub.cancel('early-chat', 'early-turn'), false);
    releaseBegin();
    const started = await starting;
    await started.done;
    assert.equal(sends, 0);
    assert.equal((hub as any).turns.get('early-chat').snapshot.status, 'cancelled');
  });

  it('persists the user message and announces it on turn_start', async () => {
    const begins: DurableTurnSnapshot[] = [];
    const hub = requestedHub(begins);
    const background: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => background.push(event), close: () => {} });
    let captured: { text: string; input: Parameters<AgentSession['send']>[1] } | undefined;
    const session: AgentSession = {
      ...sessionFrom([]),
      send: (text, input) => {
        captured = { text, input };
        return asyncIteratorFrom([{ kind: 'chunk', text: 'reply' }, { kind: 'turn_end', stopReason: 'end_turn' }]);
      },
    };
    const userMetadata = { threadMessage: { fromNodeId: 'n-a', fromTitle: 'Research notes' } };

    const started = await hub.startRequestedSelfTurn({
      chatId: 'n-b', nodeId: 'n-b', turnId: 'turn-1',
      text: 'attributed message', displayText: 'attributed message', userMetadata, session,
    });
    await started.done;

    assert.equal(begins.length, 1);
    assert.deepEqual(begins[0].userMessage && {
      id: begins[0].userMessage.id, content: begins[0].userMessage.content, metadata: begins[0].userMessage.metadata,
    }, { id: 'u-self-n-b-turn-1', content: 'attributed message', metadata: userMetadata });
    const turnStart = background.find((event) => event.event === 'turn_start');
    assert.ok(turnStart && turnStart.event === 'turn_start');
    assert.equal(turnStart.data.userText, 'attributed message');
    assert.equal(turnStart.data.selfInitiated, true);
    assert.deepEqual(turnStart.data.userMetadata, userMetadata);
    assert.equal(captured?.text, 'attributed message');
    assert.equal(captured?.input?.userMessageId, 'u-self-n-b-turn-1');
    assert.equal(captured?.input?.assistantMessageId, 'self-n-b-turn-1');
  });

  it('keeps Agent Run wake turns without a user message', async () => {
    const begins: DurableTurnSnapshot[] = [];
    const hub = requestedHub(begins);
    const background: ChatStreamEvent[] = [];
    hub.subscribeBackground({ send: (_chatId, event) => background.push(event), close: () => {} });
    let sendInput: unknown = 'unset';
    const session: AgentSession = {
      ...sessionFrom([]),
      send: (_text, input) => {
        sendInput = input;
        return asyncIteratorFrom([{ kind: 'turn_end', stopReason: 'end_turn' }]);
      },
    };

    const started = await hub.startRequestedSelfTurn({
      chatId: 'parent', nodeId: 'parent', turnId: 'wake-1', text: 'handoff', session,
    });
    await started.done;

    assert.equal(begins[0].userMessage, null);
    const turnStart = background.find((event) => event.event === 'turn_start');
    assert.ok(turnStart && turnStart.event === 'turn_start');
    assert.equal(turnStart.data.userText, '');
    assert.equal(turnStart.data.userMetadata, undefined);
    assert.deepEqual(sendInput, {
      assistantMessageId: 'self-parent-wake-1',
      turnId: 'wake-1',
    });
  });

  it('reports a requested turn queued behind a foreground turn as pending', async () => {
    let releaseForeground!: () => void;
    const foreground = (async function* (): AsyncIterableIterator<NormalizedEvent> {
      await new Promise<void>((resolve) => { releaseForeground = resolve; });
      yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent;
    })();
    const hub = requestedHub([]);
    const foregroundSession: AgentSession = { ...sessionFrom([]), send: () => foreground };
    const { done } = await hub.startTurn({ chatId: 'busy', nodeId: 'busy', text: 'user turn', session: foregroundSession });

    assert.equal(hub.hasPendingSelfTurn('busy'), false);
    const requested = hub.startRequestedSelfTurn({
      chatId: 'busy', nodeId: 'busy', turnId: 'queued-1', text: 'from A', displayText: 'from A',
      session: sessionFrom([{ kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    assert.equal(hub.hasPendingSelfTurn('busy'), true);

    releaseForeground();
    await done;
    const started = await requested;
    await started.done;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(hub.hasPendingSelfTurn('busy'), false);
  });
});
