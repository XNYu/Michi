import { describe, it, expect } from 'vitest';
import { applyTurnEvent, createDurableTurn, type ChatStreamEvent } from 'michi-shared';
import { reduceNodes } from './chatReducers';
import { mapMessageRow } from './chatHydration';
import { serializeMessageRowsForNode } from './workspacePersistence';
import { createBackgroundTurnBinding } from './observeChatStream';
import { dispatchChatStreamEvent } from '../services/chatStreamEvents';
import type { ChatNodeState } from './chatTypes';

const receipt = {
  messageId: 'steer-1', assistantId: 'a', turnId: 't', seq: 2, createdAt: 123,
  text: 'Use cobalt', pending: true, queueId: 'q',
  userMetadata: { quotedText: 'Color choice', attachments: [{ name: 'palette.txt', absPath: '/tmp/palette.txt' }] },
};
const event: ChatStreamEvent = { event: 'steer_accepted', data: receipt };
function initial(): Record<string, ChatNodeState> {
  return { n: { nodeId: 'n', projectId: 'w', chatId: 'n', kind: 'chat', status: 'streaming', activeTurnId: 't', followUps: [],
    messages: [{ id: 'u-a', role: 'user', text: 'Pick a color', toolCalls: [] },
      { id: 'a', role: 'assistant', text: '', blocks: [], toolCalls: [], streaming: true }],
    pendingQueued: [{ id: 'q', value: 'Use cobalt', mentions: [], attachments: [], queuedAt: 1 }],
  } };
}

describe('steered user messages', () => {
  it('uses the same identity and metadata in live UI, durable projection and hydration', () => {
    const state = reduceNodes(initial(), { type: 'steer-accepted', nodeId: 'n', data: receipt });
    expect(state.n.messages.map((m) => m.id)).toEqual(['u-a', 'steer-1', 'a']);
    expect(state.n.messages[1]).toMatchObject({ role: 'user', text: 'Use cobalt', steered: true, createdAt: 123, ...receipt.userMetadata });
    expect(state.n.status).toBe('streaming');
    expect(state.n.activeTurnId).toBe('t');
    expect(state.n.messages.at(-1)?.streaming).toBe(true);
    expect(state.n.pendingQueued).toBeUndefined();
    const turn = applyTurnEvent(createDurableTurn({ turnId: 't', assistantId: 'a', nodeId: 'n', workspaceId: 'w', displayUserText: 'Pick a color', startedAt: 1 }), event);
    const message = turn.steeredMessages![0];
    expect(mapMessageRow({ id: message.id, role: message.role, content: message.content, metadata: message.metadata, created_at: message.createdAt })).toEqual(state.n.messages[1]);
    const persisted = serializeMessageRowsForNode(state, 'n').find((row) => row.id === 'steer-1')!;
    expect(mapMessageRow(persisted)).toEqual(state.n.messages[1]);
    expect(applyTurnEvent(turn, { ...event, data: { ...receipt, seq: 3 } }).steeredMessages).toHaveLength(1);
  });

  it('deduplicates HTTP acknowledgement and observer replay without removing newer input', () => {
    let nodes = reduceNodes(initial(), { type: 'steer-accepted', nodeId: 'n', data: receipt });
    nodes = reduceNodes(nodes, { type: 'queue-message', nodeId: 'n', message: { id: 'new', value: 'new instruction', mentions: [], attachments: [], queuedAt: 2 } });
    const before = nodes;
    const handlers = createBackgroundTurnBinding({ chatId: 'n', nodeId: 'n', lastTurnRef: { current: '' }, lastSeqRef: { current: -1 },
      dispatch: (action) => { nodes = reduceNodes(nodes, action); },
    }).createHandlers();
    dispatchChatStreamEvent(event, handlers);
    dispatchChatStreamEvent(event, handlers);
    expect(nodes.n.messages).toBe(before.n.messages);
    expect(nodes.n.pendingQueued?.map((q) => q.id)).toEqual(['new']);
    expect(nodes.n.status).toBe('streaming');
    expect(nodes.n.lastAppliedBackgroundSeq).toBe(2);
  });

  it('keeps a late receipt with its old reply without changing the newer turn', () => {
    const nodes = initial();
    nodes.n.messages.push({ id: 'new-a', role: 'assistant', text: '', toolCalls: [], streaming: true });
    nodes.n.activeTurnId = 'new-turn';
    const next = reduceNodes(nodes, { type: 'steer-accepted', nodeId: 'n', data: receipt });
    expect(next.n.messages.map((m) => m.id)).toEqual(['u-a', 'steer-1', 'a', 'new-a']);
    expect(next.n.activeTurnId).toBe('new-turn');
    expect(next.n.status).toBe('streaming');
    expect(reduceNodes(nodes, { type: 'steer-accepted', nodeId: 'n', data: { ...receipt, assistantId: 'unknown' } })).toBe(nodes);
  });
});
