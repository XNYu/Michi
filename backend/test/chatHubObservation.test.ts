import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent, DurableTurnSnapshot } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession, CompactResult, SteerResult } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';

// Copied per COMMON.md / R1 §8 convention: there is no shared test-utils
// module for these helpers, so every chatHub*.test.ts file defines its own.

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

function hub(overrides: Partial<{
  begin: (snapshot: DurableTurnSnapshot) => void | Promise<void>;
  checkpoint: (snapshot: DurableTurnSnapshot) => void;
  finalize: (snapshot: DurableTurnSnapshot) => void | Promise<void>;
}> = {}): ChatHub {
  const noop = (_snapshot: DurableTurnSnapshot) => {};
  return new ChatHub({
    retentionMs: 5_000,
    workspaceIdForNode: () => 'ws-test',
    persistence: {
      begin: overrides.begin ?? noop,
      checkpoint: overrides.checkpoint ?? noop,
      finalize: overrides.finalize ?? noop,
    },
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

describe('ChatHub.getSnapshot', () => {
  it('returns null when the node is unknown to this process', () => {
    const chatHub = hub();
    assert.equal(chatHub.getSnapshot('never-seen'), null);
  });

  it('reflects an active turn and advances the cursor as events arrive', async () => {
    const chatHub = hub();
    const gate = { release: () => {} };
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: delayedIterator([{ kind: 'chunk', text: 'hi' }, { kind: 'turn_end', stopReason: 'end_turn' }], gate),
      }),
    });

    const beforeChunk = chatHub.getSnapshot('node-a');
    assert.ok(beforeChunk);
    assert.equal(beforeChunk.inMemoryStatus, 'active');
    assert.equal(beforeChunk.durableStatus, 'active');
    assert.equal(beforeChunk.turnId, started.turnId);
    // turn_start was already stamped (seq 0) before startTurn returned.
    assert.equal(beforeChunk.cursor.seq, 0);

    gate.release();
    await started.done;

    const after = chatHub.getSnapshot('node-a');
    assert.ok(after);
    assert.equal(after.inMemoryStatus, 'ended');
    assert.equal(after.durableStatus, 'completed');
    assert.ok(after.cursor.seq > beforeChunk.cursor.seq);
  });

  it('reports an error turn with the message', async () => {
    const chatHub = hub();
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({ events: [{ kind: 'runtime_error', error: 'boom' } as unknown as NormalizedEvent] }),
    });
    await started.done;
    const snapshot = chatHub.getSnapshot('node-a');
    assert.ok(snapshot);
    assert.equal(snapshot.inMemoryStatus, 'error');
    assert.equal(snapshot.durableStatus, 'error');
    assert.equal(snapshot.error, 'boom');
  });

  it('exposes cancelRequestedAt while cancellation is pending but not yet terminal', async () => {
    const chatHub = hub();
    const gate = { release: () => {} };
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: delayedIterator([{ kind: 'chunk', text: 'hi' }, { kind: 'turn_end' }], gate),
      }),
    });
    const before = Date.now();
    chatHub.cancel('node-a', started.turnId);
    const pending = chatHub.getSnapshot('node-a');
    assert.ok(pending);
    assert.ok(pending.cancelRequestedAt !== null);
    assert.ok(pending.cancelRequestedAt! >= before);
    // No terminal durable status yet — the turn is still active in-memory.
    assert.equal(pending.inMemoryStatus, 'active');
    assert.equal(pending.durableStatus, 'active');
    gate.release();
    await started.done;
  });

  it('marks lastPersistenceError and does NOT advance durableStatus to completed when finalize throws', async () => {
    const chatHub = hub({
      finalize: () => { throw new Error('disk full'); },
    });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({ events: [{ kind: 'chunk', text: 'hi' }, { kind: 'turn_end', stopReason: 'end_turn' }] }),
    });
    await started.done;
    const snapshot = chatHub.getSnapshot('node-a');
    assert.ok(snapshot);
    // The single most important assertion in this task: a failed commit
    // must never read as success.
    assert.equal(snapshot.inMemoryStatus, 'error');
    assert.notEqual(snapshot.durableStatus, 'completed');
    assert.equal(snapshot.durableStatus, 'active');
    assert.ok(snapshot.lastPersistenceError);
    assert.match(snapshot.lastPersistenceError!.message, /disk full/);
    assert.equal(snapshot.lastPersistenceError!.recoverable, true);
    assert.ok(snapshot.lastPersistenceError!.occurredAt > 0);
  });

  it('exposes a waiting reason for a pending permission request without leaking the raw event', async () => {
    const chatHub = hub();
    // A dedicated iterator that pauses AFTER yielding permission_request but
    // BEFORE yielding turn_end, so the mid-turn snapshot below is taken while
    // the permission card is genuinely still open. delayedIterator (used
    // elsewhere in this file) instead pauses before the FIRST event, which
    // would leave nothing applied yet.
    let resolveGate: () => void = () => {};
    const opened = new Promise<void>((resolve) => { resolveGate = resolve; });
    const events: AsyncIterableIterator<NormalizedEvent> = (() => {
      let index = 0;
      const queue: NormalizedEvent[] = [
        { kind: 'permission_request', requestId: 1, title: 'Run rm -rf /tmp/foo?', options: [] },
        { kind: 'turn_end' },
      ];
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (index === 1) await opened;
          return index < queue.length
            ? { done: false, value: queue[index++] }
            : { done: true, value: undefined };
        },
      };
    })();
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({ events }),
    });
    // startTurn resolves once runTurn() is kicked off, not once its first
    // event is consumed (the for-await loop hasn't necessarily run yet) — so
    // poll briefly for the permission_request to be applied before asserting
    // on the mid-turn snapshot.
    let snapshot = chatHub.getSnapshot('node-a');
    for (let i = 0; i < 50 && snapshot?.pendingInteraction.waiting !== true; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      snapshot = chatHub.getSnapshot('node-a');
    }
    assert.ok(snapshot);
    assert.deepEqual(snapshot.pendingInteraction, { waiting: true, reason: 'Run rm -rf /tmp/foo?' });
    assert.equal((snapshot as unknown as Record<string, unknown>).pendingPermission, undefined);
    assert.ok(!('data' in (snapshot.pendingInteraction as object)));
    resolveGate();
    await started.done;
  });

  it('is immutable: mutating the returned snapshot does not affect ChatHub state', async () => {
    const chatHub = hub();
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({ events: [{ kind: 'chunk', text: 'hi' }, { kind: 'turn_end', stopReason: 'end_turn' }] }),
    });
    await started.done;
    const first = chatHub.getSnapshot('node-a');
    assert.ok(first);
    // Mutate nested arrays in the returned copy.
    first.snapshot.assistantMessage.blocks.push({ id: 'injected', kind: 'answer', rawText: 'tampered' });
    (first.snapshot.assistantMessage.blocks[0] as { rawText: string }).rawText = 'tampered-in-place';

    const second = chatHub.getSnapshot('node-a');
    assert.ok(second);
    assert.notDeepEqual(second.snapshot.assistantMessage.blocks, first.snapshot.assistantMessage.blocks);
    assert.ok(!second.snapshot.assistantMessage.blocks.some((b) => b.id === 'injected'));
  });

  it('does not interfere with a turn advancing after a mid-turn snapshot is taken', async () => {
    const chatHub = hub();
    const gate = { release: () => {} };
    const events: ChatStreamEvent[] = [];
    chatHub.subscribe('node-a', { send: (ev) => events.push(ev), close: () => {} });
    const started = await chatHub.startTurn({
      chatId: 'node-a',
      nodeId: 'node-a',
      text: 'hello',
      session: mockSession({
        events: delayedIterator([{ kind: 'chunk', text: 'hi' }, { kind: 'turn_end', stopReason: 'end_turn' }], gate),
      }),
    });
    const midTurn = chatHub.getSnapshot('node-a');
    assert.ok(midTurn);
    assert.equal(midTurn.inMemoryStatus, 'active');

    gate.release();
    await started.done;

    // The earlier snapshot object itself must not have changed underneath us.
    assert.equal(midTurn.inMemoryStatus, 'active');
    assert.equal(midTurn.durableStatus, 'active');

    // The turn itself completed normally — getSnapshot did not perturb it.
    assert.ok(events.some((ev) => ev.event === 'done'));
    const finalSnapshot = chatHub.getSnapshot('node-a');
    assert.ok(finalSnapshot);
    assert.equal(finalSnapshot.durableStatus, 'completed');
  });
});
