import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { ChatStreamEvent } from 'michi-shared';
import type { DurableTurnSnapshot } from 'michi-shared';

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

    const { done } = hub.startTurn({
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

    assert.deepEqual(capturedInput, {
      attachments: [{ name: 'screen.png', absPath: '/tmp/screen.png' }],
    });
  });

  it('routes foreground turns only to direct subscribers and self turns only to background subscribers', async () => {
    const hub = hubWithPersistence();
    const direct: ChatStreamEvent[] = [];
    const background: Array<{ chatId: string; event: ChatStreamEvent }> = [];
    hub.subscribeBackground({
      send: (chatId, event) => background.push({ chatId, event }),
      close: () => {},
    });

    const { done, turnId } = hub.startTurn({
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
    const { done } = hub.startTurn({
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

    const { done } = hub.startTurn({
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

    const { done } = hub.startTurn({
      chatId: 'structured-overview-chat',
      nodeId: 'structured-overview-node',
      text: 'Update the overview',
      session: sessionFrom([
        { kind: 'chunk', text: 'Visible answer body.' },
        { kind: 'branch_overview', overview: 'Structured Tool overview.' },
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

    const { done } = hub.startTurn({
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

    const { done } = hub.startTurn({
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

    const { done } = hub.startTurn({
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

    const { done } = hub.startTurn({
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

    const { done } = hub.startTurn({
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

    assert.throws(() => hub.startTurn({
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
  it('reserves a client turn id when Stop beats POST /message', () => {
    const hub = hubWithPersistence();
    const session: AgentSession = {
      id: 'reserved-session', runtimeId: 'kiro', getHistory: () => [], getPendingAssistant: () => undefined,
      async *send() { yield { kind: 'turn_end', stopReason: 'end_turn' } as NormalizedEvent; },
      cancel: () => {},
    };

    assert.equal(hub.cancel('reserved-chat', 'reserved-turn'), false);
    assert.throws(
      () => hub.startTurn({
        chatId: 'reserved-chat', nodeId: 'reserved-node', text: 'must not run',
        turnId: 'reserved-turn', session,
      }),
      /cancelled before it started/,
    );
  });

  it('ignores a delayed cancel from the previous turn', async () => {
    const hub = hubWithPersistence();
    const first = hub.startTurn({
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
    const second = hub.startTurn({
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

    const { done } = hub.startTurn({ chatId: 'cancel-terminal-chat', nodeId: 'cancel-terminal-node', text: 'hello', session });
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

    const { done } = hub.startTurn({
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
