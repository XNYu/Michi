import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent, DurableTurnSnapshot } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession, CompactResult, SteerResult } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import { MemoryHarnessJournal } from '../src/services/harnessJournal';
import { CANCEL_TIMEOUT_MS } from '../src/config/constants';

function iterator(events: NormalizedEvent[]): AsyncIterableIterator<NormalizedEvent> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      return index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined };
    },
  };
}

function delayedIterator(events: NormalizedEvent[], gate: { release: () => void }): AsyncIterableIterator<NormalizedEvent> {
  let index = 0;
  let resolveGate: () => void = () => {};
  const opened = new Promise<void>((resolve) => { resolveGate = resolve; });
  gate.release = resolveGate;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (index === 0) await opened;
      return index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined };
    },
  };
}

function hub(journal?: MemoryHarnessJournal): ChatHub {
  const noop = (_snapshot: DurableTurnSnapshot) => {};
  return new ChatHub({
    retentionMs: 5_000,
    workspaceIdForNode: () => 'workspace-a',
    persistence: { begin: noop, checkpoint: noop, finalize: noop },
    journal,
  });
}

function mockSession(opts: {
  events: NormalizedEvent[] | AsyncIterableIterator<NormalizedEvent>;
  cancelAck?: boolean;
  steer?: (text: string) => Promise<SteerResult>;
  followUp?: (text: string) => Promise<SteerResult>;
  compact?: (instructions?: string) => Promise<CompactResult>;
  clearQueue?: () => void;
}): AgentSession {
  const events = Array.isArray(opts.events) ? iterator(opts.events) : opts.events;
  return {
    id: 'node-a',
    runtimeId: 'pi',
    getHistory: () => [],
    getPendingAssistant: () => undefined,
    send: async function* () {
      for await (const ev of events) yield ev;
    },
    cancel: () => (opts.cancelAck === undefined ? undefined : { acknowledged: opts.cancelAck }),
    steer: opts.steer,
    followUp: opts.followUp,
    compact: opts.compact,
    clearQueue: opts.clearQueue,
  };
}

describe('ChatHub provenance', () => {
  it('stamps source/confidence and dual-writes the journal', async () => {
    const journal = new MemoryHarnessJournal();
    const chatHub = hub(journal);
    const events: ChatStreamEvent[] = [];
    chatHub.subscribe('node-a', { send: (ev) => events.push(ev), close: () => {} });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: [
          { kind: 'chunk', text: 'hi' },
          { kind: 'turn_end', stopReason: 'end_turn' },
        ],
      }),
    });
    await started.done;
    assert.ok(events.every((ev) => ev.data.source && ev.data.confidence));
    assert.ok(journal.entries.length >= 2);
    assert.equal(journal.entries[0].nodeId, 'node-a');
    assert.equal(journal.entries[0].turnId, started.turnId);
    assert.equal(journal.entries[0].seq, 0);
  });

  it('continues the turn when the journal write throws', async () => {
    const journal = {
      append() { throw new Error('disk full'); },
    };
    const chatHub = hub(journal as any);
    const events: ChatStreamEvent[] = [];
    chatHub.subscribe('node-a', { send: (ev) => events.push(ev), close: () => {} });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({ events: [{ kind: 'chunk', text: 'hi' }, { kind: 'turn_end' }] }),
    });
    await started.done;
    assert.ok(events.some((ev) => ev.event === 'chunk'));
    assert.ok(events.some((ev) => ev.event === 'done'));
  });
});

describe('cancel phase', () => {
  it('late end-of-stream cannot publish an old overview after the next turn starts', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const chatHub = hub();
    let releaseOld!: () => void;
    let initialSent!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const ready = new Promise<void>((resolve) => { initialSent = resolve; });
    const first = await chatHub.startTurn({
      chatId: 'node-a', nodeId: 'node-a', text: 'old', turnId: 'old-overview',
      session: mockSession({ events: (async function* (): AsyncIterableIterator<NormalizedEvent> {
        yield { kind: 'chunk', text: '[BRANCH-OVERVIEW: Old turn summary]' };
        initialSent();
        await oldGate;
      })() }),
    });
    await ready;
    chatHub.cancel('node-a', first.turnId);
    t.mock.timers.tick(CANCEL_TIMEOUT_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const nextGate = { release() {} };
    const second = await chatHub.startTurn({
      chatId: 'node-a', nodeId: 'node-a', text: 'new', turnId: 'new-overview',
      session: mockSession({ events: delayedIterator([{ kind: 'turn_end' }], nextGate) }),
    });
    const events: ChatStreamEvent[] = [];
    chatHub.subscribe('node-a', { send: (event) => events.push(event), close() {} });
    events.length = 0;
    releaseOld();
    await first.done;
    const lateEvents = [...events];
    nextGate.release();
    await second.done;
    assert.deepEqual(lateEvents, [], 'ended turns must not append overview/checkpoint events');
  });

  it('cancel timeout and runtime completion share one in-flight durable finalization', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    let finalizeCalls = 0;
    const chatHub = new ChatHub({
      workspaceIdForNode: () => 'workspace-a',
      persistence: { begin() {}, checkpoint() {}, finalize() { finalizeCalls += 1; return committed; } },
    });
    const gate = { release: () => {} };
    const events: ChatStreamEvent[] = [];
    chatHub.subscribe('node-a', { send: (event) => events.push(event), close() {} });
    const first = await chatHub.startTurn({
      chatId: 'node-a', nodeId: 'node-a', text: 'old',
      session: mockSession({ events: delayedIterator([{ kind: 'turn_end' }], gate) }),
    });
    chatHub.cancel('node-a', first.turnId);
    t.mock.timers.tick(CANCEL_TIMEOUT_MS);
    gate.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsBeforeCommit = finalizeCalls;
    assert.equal(events.filter((event) => event.event === 'done').length, 0);
    commit();
    await first.done;
    assert.equal(callsBeforeCommit, 1);
    assert.equal(events.filter((event) => event.event === 'done').length, 1);
  });

  it('late completion of a force-cancelled turn cannot finalize twice or tear down the next turn', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const finalized: string[] = [];
    const chatHub = new ChatHub({
      retentionMs: 60_000, workspaceIdForNode: () => 'workspace-a',
      persistence: { begin() {}, checkpoint() {}, finalize(snapshot) { finalized.push(snapshot.turnId); } },
    });
    const oldGate = { release: () => {} };
    const newGate = { release: () => {} };
    const first = await chatHub.startTurn({
      chatId: 'node-a', nodeId: 'node-a', text: 'old', turnId: 'old-turn',
      session: mockSession({ events: delayedIterator([{ kind: 'chunk', text: 'stale' }, { kind: 'turn_end' }], oldGate) }),
    });
    chatHub.cancel('node-a', first.turnId);
    t.mock.timers.tick(CANCEL_TIMEOUT_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(chatHub.isActive('node-a'), false);
    const second = await chatHub.startTurn({
      chatId: 'node-a', nodeId: 'node-a', text: 'new', turnId: 'new-turn',
      session: mockSession({ events: delayedIterator([{ kind: 'turn_end' }], newGate) }),
    });
    let closed = 0;
    const events: ChatStreamEvent[] = [];
    chatHub.subscribeTurn('node-a', second.turnId, { send: (event) => events.push(event), close: () => { closed += 1; } });
    oldGate.release();
    await first.done;
    const ownerAfterOldCleanup = chatHub.activeOwnerTurnId('node-a');
    const closedAfterOldCleanup = closed;
    const finalizedAfterOldCleanup = [...finalized];
    newGate.release();
    await second.done;
    assert.deepEqual(finalizedAfterOldCleanup, ['old-turn'], 'old turn must be finalized only once');
    assert.equal(ownerAfterOldCleanup, second.turnId, 'old finally must not drop the new active session');
    assert.equal(closedAfterOldCleanup, 0, 'old finally must not close the next SSE subscription');
    assert.ok(events.every((event) => event.data.turnId === second.turnId));
  });

  it('emits requested then acknowledged then settled only on terminal done', async () => {
    const chatHub = hub();
    const events: ChatStreamEvent[] = [];
    const gate = { release: () => {} };
    chatHub.subscribe('node-a', { send: (ev) => events.push(ev), close: () => {} });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: delayedIterator([{ kind: 'chunk', text: 'hi' }, { kind: 'turn_end' }], gate),
        cancelAck: true,
      }),
    });
    assert.equal(chatHub.cancel('node-a', started.turnId), true);
    gate.release();
    await started.done;
    const phases = events.filter((ev) => ev.event === 'cancel_phase').map((ev) => ev.data.phase);
    assert.deepEqual(phases, ['requested', 'acknowledged', 'settled']);
    assert.ok(events.some((ev) => ev.event === 'done'));
  });

  it('does not emit acknowledged when cancel() has no ack', async () => {
    const chatHub = hub();
    const events: ChatStreamEvent[] = [];
    const gate = { release: () => {} };
    chatHub.subscribe('node-a', { send: (ev) => events.push(ev), close: () => {} });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: delayedIterator([{ kind: 'turn_end' }], gate),
      }),
    });
    chatHub.cancel('node-a', started.turnId);
    gate.release();
    await started.done;
    const phases = events.filter((ev) => ev.event === 'cancel_phase').map((ev) => ev.data.phase);
    assert.deepEqual(phases, ['requested', 'settled']);
  });

  it('does not settle when a subscriber disconnects', async () => {
    const chatHub = hub();
    const events: ChatStreamEvent[] = [];
    const gate = { release: () => {} };
    const detach = chatHub.subscribe('node-a', { send: (ev) => events.push(ev), close: () => {} });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: delayedIterator([{ kind: 'chunk', text: 'still going' }, { kind: 'turn_end' }], gate),
      }),
    });
    detach();
    assert.equal(chatHub.isActive('node-a'), true);
    assert.equal(events.some((ev) => ev.event === 'cancel_phase' && ev.data.phase === 'settled'), false);
    gate.release();
    await started.done;
  });
});

describe('ChatHub optional session methods', () => {
  it('returns invisible when steer is missing', async () => {
    const chatHub = hub();
    const gate = { release: () => {} };
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({ events: delayedIterator([{ kind: 'turn_end' }], gate) }),
    });
    const result = await chatHub.steer('node-a', 'inject');
    assert.deepEqual(result, { accepted: false, reason: 'invisible' });
    gate.release();
    await started.done;
  });

  it('forwards steer when the session implements it', async () => {
    const chatHub = hub();
    const events: ChatStreamEvent[] = [];
    const gate = { release: () => {} };
    chatHub.subscribe('node-a', { send: (ev) => events.push(ev), close: () => {} });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: delayedIterator([{ kind: 'turn_end' }], gate),
        steer: async (text) => ({ accepted: true, pending: true, turnId: 'native-1' }),
      }),
    });
    const result = await chatHub.steer('node-a', 'inject this turn');
    assert.equal(result.accepted, true);
    assert.equal(result.pending, true);
    assert.ok(events.some((ev) => ev.event === 'steer_accepted'));
    gate.release();
    await started.done;
  });
});
