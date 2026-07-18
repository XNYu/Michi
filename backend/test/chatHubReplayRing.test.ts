import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent, DurableTurnSnapshot } from 'michi-shared';
import { ChatHub } from '../src/agents/chatHub';
import type { NormalizedEvent } from '../src/services/chatEvents';

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

function hub(retentionMs = 1_000): ChatHub {
  const noop = (_snapshot: DurableTurnSnapshot) => {};
  return new ChatHub({
    retentionMs,
    workspaceIdForNode: () => 'workspace-a',
    persistence: { begin: noop, checkpoint: noop, finalize: noop },
  });
}

describe('ChatHub replay ring', () => {
  it('replays turn A tail before turn B when reconnecting with an A cursor', async () => {
    const chatHub = hub();
    const firstConnection: ChatStreamEvent[] = [];
    let detach = () => {};
    detach = chatHub.subscribe('chat-a', {
      send: (event) => {
        firstConnection.push(event);
        if (event.event === 'chunk') detach();
      },
      close: () => {},
    });

    chatHub.startSelfTurn({
      chatId: 'chat-a',
      nodeId: 'node-a',
      events: iterator([
        { kind: 'chunk', text: 'turn A' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const turnAChunk = firstConnection.find((event) => event.event === 'chunk');
    assert(turnAChunk?.data.turnId);
    assert.equal(typeof turnAChunk.data.seq, 'number');

    chatHub.startSelfTurn({
      chatId: 'chat-a',
      nodeId: 'node-a',
      events: iterator([
        { kind: 'chunk', text: 'turn B' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const replayed: ChatStreamEvent[] = [];
    chatHub.subscribe('chat-a', {
      send: (event) => replayed.push(event),
      close: () => {},
    }, {
      fromTurnId: turnAChunk.data.turnId,
      fromSeq: (turnAChunk.data.seq ?? 0) + 1,
    });

    const events = replayed.map((event) => `${event.data.turnId}:${event.event}`);
    assert.equal(events[0], `${turnAChunk.data.turnId}:done`);
    assert.equal(replayed[1]?.event, 'turn_start');
    assert.equal(replayed[2]?.event, 'chunk');
    assert.equal(replayed[3]?.event, 'done');
    assert.notEqual(replayed[1]?.data.turnId, turnAChunk.data.turnId);
  });

  it('evicts completed replay logs after the retention window', async () => {
    const chatHub = hub(20);
    chatHub.startSelfTurn({
      chatId: 'chat-expiring',
      nodeId: 'node-expiring',
      events: iterator([{ kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    const deadline = Date.now() + 2_000;
    while (
      ((chatHub as any).turns.has('chat-expiring')
        || (chatHub as any).retainedTurns.has('chat-expiring'))
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const replayed: ChatStreamEvent[] = [];
    chatHub.subscribe('chat-expiring', {
      send: (event) => replayed.push(event),
      close: () => {},
    });

    assert.deepEqual(replayed, []);
  });

  it('uses a per-chat cursor so reconnect does not replay already applied self turns', async () => {
    const chatHub = hub();
    const first: ChatStreamEvent[] = [];
    chatHub.subscribeBackground({ send: (_chatId, event) => first.push(event), close: () => {} });
    chatHub.startSelfTurn({
      chatId: 'chat-cursor',
      nodeId: 'node-cursor',
      events: iterator([{ kind: 'chunk', text: 'A' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    chatHub.startSelfTurn({
      chatId: 'chat-cursor',
      nodeId: 'node-cursor',
      events: iterator([{ kind: 'chunk', text: 'B' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const latestDone = [...first].reverse().find((event) => event.event === 'done')!;

    const replayed: ChatStreamEvent[] = [];
    chatHub.subscribeBackground(
      { send: (_chatId, event) => replayed.push(event), close: () => {} },
      {
        cursors: {
          'chat-cursor': { turnId: latestDone.data.turnId!, seq: latestDone.data.seq! },
        },
      },
    );

    assert.deepEqual(replayed, []);
  });

  it('signals a durable gap when the client cursor fell out of the replay ring', async () => {
    const chatHub = hub(20);
    const first: ChatStreamEvent[] = [];
    chatHub.subscribeBackground({ send: (_chatId, event) => first.push(event), close: () => {} });
    chatHub.startSelfTurn({
      chatId: 'chat-gap',
      nodeId: 'node-gap',
      events: iterator([{ kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const oldDone = first.find((event) => event.event === 'done')!;
    const gaps: Array<{ chatId: string; turnId: string; seq: number }> = [];

    chatHub.subscribeBackground(
      {
        send: () => {},
        gap: (chatId, cursor) => gaps.push({ chatId, ...cursor }),
        close: () => {},
      },
      {
        cursors: { 'chat-gap': { turnId: 'older-client-turn', seq: 2 } },
        durableCursors: {
          'chat-gap': { turnId: oldDone.data.turnId!, seq: oldDone.data.seq! },
        },
      },
    );

    assert.deepEqual(gaps, [{
      chatId: 'chat-gap',
      turnId: oldDone.data.turnId!,
      seq: oldDone.data.seq!,
    }]);
  });

  it('continues replaying after the durable cursor once a missing client cursor is reconciled', async () => {
    const chatHub = hub();
    const first: ChatStreamEvent[] = [];
    chatHub.subscribeBackground({ send: (_chatId, event) => first.push(event), close: () => {} });
    chatHub.startSelfTurn({
      chatId: 'chat-gap-tail',
      nodeId: 'node-gap-tail',
      events: iterator([
        { kind: 'chunk', text: 'persisted' },
        { kind: 'chunk', text: 'tail' },
        { kind: 'turn_end', stopReason: 'end_turn' },
      ]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const persisted = first.find((event) => event.event === 'chunk' && event.data.text === 'persisted')!;
    const gaps: string[] = [];
    const replayed: ChatStreamEvent[] = [];

    chatHub.subscribeBackground(
      {
        send: (_chatId, event) => replayed.push(event),
        gap: (chatId) => gaps.push(chatId),
        close: () => {},
      },
      {
        cursors: { 'chat-gap-tail': { turnId: 'evicted-client-turn', seq: 99 } },
        durableCursors: {
          'chat-gap-tail': { turnId: persisted.data.turnId!, seq: persisted.data.seq! },
        },
      },
    );

    assert.deepEqual(gaps, ['chat-gap-tail']);
    assert.deepEqual(replayed.map((event) => event.event), ['chunk', 'done']);
    assert.equal((replayed[0].data as { text?: string }).text, 'tail');
  });

  it('emits every gap barrier before replaying frames from another chat', async () => {
    const chatHub = hub();
    const recorded: Array<{ chatId: string; event: ChatStreamEvent }> = [];
    chatHub.subscribeBackground({
      send: (chatId, event) => recorded.push({ chatId, event }),
      close: () => {},
    });

    // Insert the child first so a one-pass replay would publish its frames
    // before discovering that the parent needs a durable graph snapshot.
    chatHub.startSelfTurn({
      chatId: 'chat-child',
      nodeId: 'node-child',
      events: iterator([{ kind: 'chunk', text: 'child frame' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    chatHub.startSelfTurn({
      chatId: 'chat-parent',
      nodeId: 'node-parent',
      events: iterator([{ kind: 'chunk', text: 'parent frame' }, { kind: 'turn_end', stopReason: 'end_turn' }]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const parentStart = recorded.find(({ chatId, event }) =>
      chatId === 'chat-parent' && event.event === 'turn_start',
    )!.event;
    const deliveryOrder: string[] = [];
    chatHub.subscribeBackground(
      {
        gap: (chatId) => deliveryOrder.push(`gap:${chatId}`),
        send: (chatId, event) => deliveryOrder.push(`send:${chatId}:${event.event}`),
        close: () => {},
      },
      {
        cursors: {
          'chat-parent': { turnId: 'evicted-parent-turn', seq: 99 },
        },
        durableCursors: {
          'chat-parent': { turnId: parentStart.data.turnId!, seq: parentStart.data.seq! },
        },
      },
    );

    assert.equal(deliveryOrder[0], 'gap:chat-parent');
    assert(deliveryOrder.some((entry) => entry.startsWith('send:chat-child:')));
  });

  it('re-emits pending interaction state after a durable gap without advancing the cursor', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    async function* pendingPermission(): AsyncIterableIterator<NormalizedEvent> {
      yield {
        kind: 'permission_request',
        requestId: 42,
        title: 'Run command',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      };
      await blocked;
      yield { kind: 'turn_end', stopReason: 'end_turn' };
    }
    const chatHub = hub();
    const first: ChatStreamEvent[] = [];
    chatHub.subscribeBackground({ send: (_chatId, event) => first.push(event), close: () => {} });
    chatHub.startSelfTurn({
      chatId: 'chat-pending-gap',
      nodeId: 'node-pending-gap',
      events: pendingPermission(),
    });
    const permission = await new Promise<ChatStreamEvent>((resolve) => {
      const poll = () => {
        const event = first.find((candidate) => candidate.event === 'permission_request');
        if (event) resolve(event);
        else setTimeout(poll, 1);
      };
      poll();
    });
    const recovered: ChatStreamEvent[] = [];

    chatHub.subscribeBackground(
      { send: (_chatId, event) => recovered.push(event), gap: () => {}, close: () => {} },
      {
        cursors: { 'chat-pending-gap': { turnId: 'evicted-client-turn', seq: 9 } },
        durableCursors: {
          'chat-pending-gap': { turnId: permission.data.turnId!, seq: permission.data.seq! },
        },
      },
    );

    const restoredPermission = recovered.find((event) => event.event === 'permission_request');
    assert.ok(restoredPermission);
    assert.equal(restoredPermission.data.requestId, 42);
    assert.equal(restoredPermission.data.seq, undefined);

    const matchingCursorRecovery: ChatStreamEvent[] = [];
    chatHub.subscribeBackground(
      { send: (_chatId, event) => matchingCursorRecovery.push(event), close: () => {} },
      {
        cursors: {
          'chat-pending-gap': { turnId: permission.data.turnId!, seq: permission.data.seq! },
        },
      },
    );
    assert.equal(
      matchingCursorRecovery.filter((event) => event.event === 'permission_request').length,
      1,
    );
    assert.equal(
      matchingCursorRecovery.find((event) => event.event === 'permission_request')?.data.seq,
      undefined,
    );

    chatHub.resolvePermission('chat-pending-gap', 42);
    const afterResolve: ChatStreamEvent[] = [];
    chatHub.subscribeBackground(
      { send: (_chatId, event) => afterResolve.push(event), gap: () => {}, close: () => {} },
      {
        cursors: { 'chat-pending-gap': { turnId: 'another-evicted-turn', seq: 10 } },
        durableCursors: {
          'chat-pending-gap': { turnId: permission.data.turnId!, seq: permission.data.seq! },
        },
      },
    );
    assert.equal(afterResolve.some((event) => event.event === 'permission_request'), false);
    release();
  });
});
