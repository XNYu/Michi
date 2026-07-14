import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub } from '../src/agents/chatHub';
import type { AgentSession } from '../src/agents/types';
import type { NormalizedEvent } from '../src/services/chatEvents';
import type { ChatStreamEvent } from 'michi-shared';

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

describe('ChatHub.startTurn', () => {
  it('publishes branch_overview before done on the owner message stream', async () => {
    const hub = new ChatHub({ retentionMs: 100 });
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
});

describe('ChatHub.startSelfTurn', () => {
  it('publishes branch_overview before done and replays it to late subscribers', async () => {
    const hub = new ChatHub({ retentionMs: 100 });
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
    const hub = new ChatHub({ retentionMs: 100 });
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
  });

  it('assistantId is prefixed with self-', async () => {
    const hub = new ChatHub({ retentionMs: 100 });
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
    const hub = new ChatHub({ retentionMs: 100 });
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
