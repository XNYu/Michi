import { describe, expect, it } from 'vitest';
import { reduceNodes } from './chatReducers';
import type { ChatNodeState, PendingQueuedMessage } from './chatTypes';

const queued = (id: string, value = 'hello'): PendingQueuedMessage => ({
  id,
  value,
  mentions: [],
  attachments: [],
  queuedAt: 0,
});

/**
 * Factory for a minimal chat node used as the reducer's starting state.
 * Only the fields the queue actions actually read/write matter; everything
 * else is filler that keeps the ChatNodeState type happy.
 */
function baseNode(overrides: Partial<ChatNodeState> = {}): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...overrides,
  };
}

describe('queue-message reducer', () => {
  it('appends to pendingQueued preserving existing entries', () => {
    const m1 = queued('q1');
    const m2 = queued('q2');
    const state = { n1: baseNode({ pendingQueued: [m1] }) };
    const next = reduceNodes(state, { type: 'queue-message', nodeId: 'n1', message: m2 });
    expect(next.n1.pendingQueued).toEqual([m1, m2]);
  });

  it('initializes pendingQueued when not present', () => {
    const m1 = queued('q1');
    const state = { n1: baseNode() };
    const next = reduceNodes(state, { type: 'queue-message', nodeId: 'n1', message: m1 });
    expect(next.n1.pendingQueued).toEqual([m1]);
  });

  it('does not affect queueErrored', () => {
    const state = { n1: baseNode({ queueErrored: true }) };
    const next = reduceNodes(state, { type: 'queue-message', nodeId: 'n1', message: queued('q1') });
    expect(next.n1.queueErrored).toBe(true);
  });

  it('is a no-op for unknown nodeId', () => {
    const state = { n1: baseNode() };
    const next = reduceNodes(state, { type: 'queue-message', nodeId: 'missing', message: queued('q1') });
    expect(next).toBe(state);
  });
});

describe('dequeue-message reducer', () => {
  it('removes by id', () => {
    const m1 = queued('q1');
    const m2 = queued('q2');
    const state = { n1: baseNode({ pendingQueued: [m1, m2] }) };
    const next = reduceNodes(state, { type: 'dequeue-message', nodeId: 'n1', messageId: 'q1' });
    expect(next.n1.pendingQueued).toEqual([m2]);
  });

  it('drops the field when last entry is removed', () => {
    const m1 = queued('q1');
    const state = { n1: baseNode({ pendingQueued: [m1] }) };
    const next = reduceNodes(state, { type: 'dequeue-message', nodeId: 'n1', messageId: 'q1' });
    expect(next.n1.pendingQueued).toBeUndefined();
  });

  it('is a no-op for unknown id', () => {
    const m1 = queued('q1');
    const state = { n1: baseNode({ pendingQueued: [m1] }) };
    const next = reduceNodes(state, { type: 'dequeue-message', nodeId: 'n1', messageId: 'q-zzz' });
    expect(next).toBe(state);
  });
});

describe('flush-queue reducer', () => {
  it('empties pendingQueued and queueErrored', () => {
    const state = {
      n1: baseNode({ pendingQueued: [queued('q1'), queued('q2')], queueErrored: true }),
    };
    const next = reduceNodes(state, { type: 'flush-queue', nodeId: 'n1' });
    expect(next.n1.pendingQueued).toBeUndefined();
    expect(next.n1.queueErrored).toBeUndefined();
  });

  it('is a no-op when queue is already empty', () => {
    const state = { n1: baseNode() };
    const next = reduceNodes(state, { type: 'flush-queue', nodeId: 'n1' });
    expect(next).toBe(state);
  });
});

describe('mark-queue-errored reducer', () => {
  it('sets queueErrored without touching the queue', () => {
    const m1 = queued('q1');
    const state = { n1: baseNode({ pendingQueued: [m1] }) };
    const next = reduceNodes(state, { type: 'mark-queue-errored', nodeId: 'n1' });
    expect(next.n1.queueErrored).toBe(true);
    expect(next.n1.pendingQueued).toEqual([m1]);
  });

  it('is a no-op when queue is empty', () => {
    const state = { n1: baseNode() };
    const next = reduceNodes(state, { type: 'mark-queue-errored', nodeId: 'n1' });
    expect(next).toBe(state);
  });
});
